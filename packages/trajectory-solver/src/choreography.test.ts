// Tests for solveChoreography (multi-ball Phase 1).
//
// Sources are imported from `./choreography.js` (resolves to .ts under Vitest)
// so tests run against current TypeScript, not a stale dist.

import { describe, it, expect } from 'vitest';

import type {
  ChoreographyTarget,
  HitRole,
  SolverConfig,
  VoicePlan,
} from '@motionscore/types';

import { solveChoreography } from './choreography.js';

const config: SolverConfig = {
  gravity: 980,
  startPosition: [960, 100],
  fps: 60,
  syncToleranceMs: 15,
};

function target(noteId: string, timeSec: number, x: number): ChoreographyTarget {
  return {
    noteId,
    timeSec,
    position: { x, y: 900 },
    impactSize: 0.5,
    colorHint: '#4477ff',
  };
}

function plan(
  id: string,
  startX: number,
  targets: ChoreographyTarget[],
  role?: HitRole,
): VoicePlan {
  const p: VoicePlan = {
    id,
    label: id,
    colorHint: '#ff6b6b',
    startPosition: [startX, 100],
    targets,
  };
  if (role !== undefined) p.role = role;
  return p;
}

describe('solveChoreography — per-voice solving (multi-ball Phase 1)', () => {
  it('solves each voice independently and preserves plan identity', () => {
    const plans = [
      plan('voice_kick', 400, [target('n0001', 0.5, 420), target('n0003', 1.0, 500)], 'kick'),
      plan('voice_snare', 1200, [target('n0002', 0.75, 1180)], 'snare'),
    ];

    const choreography = solveChoreography(plans, config);

    expect(choreography.voices).toHaveLength(2);

    const kick = choreography.voices[0]!;
    expect(kick.id).toBe('voice_kick');
    expect(kick.role).toBe('kick');
    // Each ball's trajectory carries its own objectId (the voice id).
    expect(kick.trajectory.objectId).toBe('voice_kick');
    // Launches from the voice's own start position.
    expect(kick.trajectory.keyframes[0]!.pos).toEqual([400, 100]);

    const snare = choreography.voices[1]!;
    expect(snare.trajectory.objectId).toBe('voice_snare');
    expect(snare.trajectory.keyframes[0]!.pos).toEqual([1200, 100]);
  });

  it('each voice only strikes its own targets', () => {
    const plans = [
      plan('voice_kick', 400, [target('n0001', 0.5, 420)], 'kick'),
      plan('voice_snare', 1200, [target('n0002', 0.75, 1180)], 'snare'),
    ];

    const choreography = solveChoreography(plans, config);

    const kickImpacts = choreography.voices[0]!.trajectory.keyframes
      .filter((k) => k.hitsTarget !== undefined)
      .map((k) => k.hitsTarget);
    const snareImpacts = choreography.voices[1]!.trajectory.keyframes
      .filter((k) => k.hitsTarget !== undefined)
      .map((k) => k.hitsTarget);

    expect(kickImpacts).toEqual(['n0001']);
    expect(snareImpacts).toEqual(['n0002']);
  });

  it('durationSec is the latest keyframe time across all voices', () => {
    const plans = [
      plan('voice_a', 400, [target('n0001', 0.5, 420)]),
      plan('voice_b', 1200, [target('n0002', 2.0, 1180)]),
    ];

    const choreography = solveChoreography(plans, config);

    expect(choreography.durationSec).toBeCloseTo(2.0, 5);
  });

  it('reproduces single-ball behavior for a one-voice choreography', () => {
    const plans = [
      plan('voice_all', 960, [target('n0001', 0.5, 400), target('n0002', 1.0, 1500)]),
    ];

    const choreography = solveChoreography(plans, config);

    expect(choreography.voices).toHaveLength(1);
    const impacts = choreography.voices[0]!.trajectory.keyframes
      .filter((k) => k.hitsTarget !== undefined)
      .map((k) => k.hitsTarget);
    expect(impacts).toEqual(['n0001', 'n0002']);
  });

  it('handles an empty-targets voice as an empty trajectory (duration 0)', () => {
    const plans = [plan('voice_all', 960, [])];

    const choreography = solveChoreography(plans, config);

    expect(choreography.voices[0]!.trajectory.keyframes).toHaveLength(0);
    expect(choreography.durationSec).toBe(0);
  });
});
