import { describe, expect, it } from 'vitest';
import type { AudioAnalysis, HitRole } from '../packages/web/src/client/src/renderTypes.js';
import {
  describeScene,
  roleStateAt,
  rolesForStem,
  sectionAt,
  stemForRole,
} from '../packages/web/src/client/src/visualization-state.js';

const analysis: AudioAnalysis = {
  version: 1,
  durationSec: 12,
  tempoBpm: 120,
  mode: 'stems',
  hits: [
    {
      id: 'kick-1',
      pitchMidi: 36,
      startSec: 2,
      endSec: 2.1,
      velocity: 0.9,
      role: 'kick',
    },
  ],
  featureFrames: [],
  sectionCues: [
    {
      type: 'build',
      startSec: 1,
      endSec: 4,
      intensity: 0.8,
      confidence: 0.9,
    },
  ],
  roleSignals: {
    version: 1,
    frameRateHz: 2,
    frameCount: 24,
    tracks: [
      {
        role: 'vocal',
        activityQ8: [0, 0, 220, 220, 220, 220],
        sustainSpans: [[2, 5]],
        pitchDirection: [0, 0, 1, 1, 0, -1],
      },
    ],
  },
};

describe('visualization state', () => {
  it('maps semantic roles to the playable Demucs component', () => {
    const stems = [
      { id: 'drums', label: 'Drums', url: '/drums.wav' },
      { id: 'vocals', label: 'Vocals', url: '/vocals.wav' },
    ];
    expect(stemForRole('snare', stems)).toBe('drums');
    expect(stemForRole('vocal', stems)).toBe('vocals');
    expect(rolesForStem('drums')).toEqual(['kick', 'snare', 'percussion']);
  });

  it('prioritizes a hit over continuous activity', () => {
    expect(roleStateAt(analysis, 'kick', 2.04).state).toBe('HIT');
  });

  it('reports pitch direction and macro section state', () => {
    expect(roleStateAt(analysis, 'vocal', 1.1).state).toBe('RISING');
    expect(sectionAt(analysis.sectionCues, 2)?.type).toBe('build');
    expect(describeScene(analysis, ['kick', 'vocal'] as HitRole[], 2)).toContain(
      'build section',
    );
  });
});
