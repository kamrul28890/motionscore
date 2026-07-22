// Cross-package pipeline integration test (Stage B -> C -> D).
//
// The per-package suites test each stage in isolation. This test verifies the
// stages *compose* correctly across package boundaries: a real (in-memory) MIDI
// file is parsed by @motionscore/note-extractor, mapped by
// @motionscore/musical-mapper, and solved by @motionscore/trajectory-solver,
// with the shared @motionscore/types validators run at every boundary.
//
// Covers two MotionScore checkpoints:
//   - Checkpoint 4 (Core data pipeline): MIDI -> NoteEvent[] -> ChoreographyTarget[]
//   - Checkpoint 6 (Solver correctness): ChoreographyTarget[] -> ObjectTrajectory
//     with impact timing within the configured sync tolerance.
//
// @tonejs/midi is a CommonJS bundle under ESM: a *default* import exposes the
// module object and `Midi` is read from it (a named import crashes at runtime).
// This mirrors the workaround in @motionscore/note-extractor.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import midiModule from '@tonejs/midi';

import { parseMidi } from '@motionscore/note-extractor';
import { mapNotes } from '@motionscore/musical-mapper';
import { solveTrajectory } from '@motionscore/trajectory-solver';
import {
  validateChoreographyTargets,
  validateNoteEvents,
  validateObjectTrajectory,
  type ChoreographyTarget,
  type LayoutConfig,
  type NoteEvent,
  type ObjectTrajectory,
  type SolverConfig,
} from '@motionscore/types';

const { Midi } = midiModule;

/** Canvas / layout constants shared by the mapper and the bounds assertions. */
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

/** Sync tolerance (ms) used by the solver and asserted against impacts. */
const SYNC_TOLERANCE_MS = 15;

/**
 * A small, deterministic multi-note phrase used to build the test MIDI.
 *
 * - times are strictly increasing and start > 0 so the first arc has a positive
 *   duration (a target at t=0 would be skipped by the solver's degenerate-gap
 *   guard);
 * - pitches are varied and lie within the mapped piano range [21, 108];
 * - velocities are >= 0.5 (raw MIDI >= ~64) and durations >= 0.05s so every note
 *   round-trips through MIDI encode/decode without being dropped.
 */
interface TestNoteSpec {
  midi: number;
  time: number;
  duration: number;
  velocity: number;
}

const TEST_NOTES: readonly TestNoteSpec[] = [
  { midi: 60, time: 0.5, duration: 0.3, velocity: 0.5 },
  { midi: 64, time: 1.0, duration: 0.3, velocity: 0.6 },
  { midi: 67, time: 1.5, duration: 0.3, velocity: 0.7 },
  { midi: 72, time: 2.0, duration: 0.3, velocity: 0.8 },
  { midi: 69, time: 2.5, duration: 0.3, velocity: 0.9 },
  { midi: 65, time: 3.0, duration: 0.3, velocity: 1.0 },
  { midi: 62, time: 3.5, duration: 0.3, velocity: 0.55 },
];

const layoutConfig: LayoutConfig = {
  type: 'piano-keys',
  canvasWidth: CANVAS_WIDTH,
  canvasHeight: CANVAS_HEIGHT,
  targetY: 900,
  pitchRange: [21, 108],
  colorScheme: 'circle-of-fifths',
};

const solverConfig: SolverConfig = {
  gravity: 980,
  startPosition: [960, 100],
  fps: 60,
  syncToleranceMs: SYNC_TOLERANCE_MS,
};

/** Encode the test phrase into an in-memory MIDI byte array. */
function buildTestMidi(): Uint8Array {
  const midi = new Midi();
  const track = midi.addTrack();
  track.name = 'melody';
  for (const note of TEST_NOTES) {
    track.addNote({
      midi: note.midi,
      time: note.time,
      duration: note.duration,
      velocity: note.velocity,
    });
  }
  return midi.toArray();
}

describe('MotionScore pipeline integration (Stage B -> C -> D)', () => {
  let tempDir: string;
  let midiPath: string;

  // Pipeline artifacts, produced once and asserted on across the tests below.
  let notes: NoteEvent[];
  let targets: ChoreographyTarget[];
  let trajectory: ObjectTrajectory;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'motionscore-int-'));
    midiPath = join(tempDir, 'phrase.mid');
    await writeFile(midiPath, Buffer.from(buildTestMidi()));

    // The whole chain runs here; if any stage throws, every test below fails
    // with the originating error (satisfies "the chain runs without throwing").
    notes = await parseMidi(midiPath); // Stage B
    targets = mapNotes(notes, layoutConfig); // Stage C
    trajectory = solveTrajectory(targets, solverConfig); // Stage D
  });

  afterAll(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('Checkpoint 4 - parseMidi produces a valid, non-empty NoteEvent[] (Stage B)', () => {
    expect(notes.length).toBe(TEST_NOTES.length);

    // ids are unique across the array (Property 10 at the integration boundary).
    const uniqueIds = new Set(notes.map((note) => note.id));
    expect(uniqueIds.size).toBe(notes.length);

    // velocity normalized into [0, 1] (Property 11).
    for (const note of notes) {
      expect(note.velocity).toBeGreaterThanOrEqual(0);
      expect(note.velocity).toBeLessThanOrEqual(1);
    }

    // parseMidi postcondition: events sorted by startSec ascending.
    for (let i = 1; i < notes.length; i += 1) {
      expect(notes[i]!.startSec).toBeGreaterThanOrEqual(notes[i - 1]!.startSec);
    }

    // Stage B -> C boundary validator accepts the extracted notes.
    expect(() => validateNoteEvents(notes)).not.toThrow();
  });

  it('Checkpoint 4 - mapNotes produces in-bounds, time-sorted ChoreographyTarget[] (Stage C)', () => {
    // No density filter configured, so every note maps to exactly one target.
    expect(targets.length).toBe(notes.length);

    for (const target of targets) {
      expect(target.position.x).toBeGreaterThanOrEqual(0);
      expect(target.position.x).toBeLessThanOrEqual(CANVAS_WIDTH);
      expect(target.position.y).toBeGreaterThanOrEqual(0);
      expect(target.position.y).toBeLessThanOrEqual(CANVAS_HEIGHT);
      expect(target.impactSize).toBeGreaterThanOrEqual(0);
      expect(target.impactSize).toBeLessThanOrEqual(1);
    }

    // Output ordered by timeSec ascending (Property 9 / Req 3.6).
    for (let i = 1; i < targets.length; i += 1) {
      expect(targets[i]!.timeSec).toBeGreaterThanOrEqual(targets[i - 1]!.timeSec);
    }

    // Stage C -> D boundary validator accepts the targets. Passing the source
    // notes also verifies every noteId resolves and timeSec === startSec.
    expect(() =>
      validateChoreographyTargets(targets, CANVAS_WIDTH, CANVAS_HEIGHT, notes),
    ).not.toThrow();
  });

  it('Checkpoint 6 - solveTrajectory yields strictly ascending keyframes within sync tolerance (Stage D)', () => {
    expect(trajectory.keyframes.length).toBeGreaterThan(0);

    // Keyframes strictly ascending by tSec (Property 4 / Req 4.4).
    for (let i = 1; i < trajectory.keyframes.length; i += 1) {
      expect(trajectory.keyframes[i]!.tSec).toBeGreaterThan(
        trajectory.keyframes[i - 1]!.tSec,
      );
    }

    // Every impact keyframe lands within +/- syncToleranceMs of its target
    // (Property 2 / Req 4.2). Track the worst-case error for the report.
    const targetTimeById = new Map(
      targets.map((target) => [target.noteId, target.timeSec] as const),
    );
    const impacts = trajectory.keyframes.filter(
      (keyframe) => keyframe.hitsTarget !== undefined,
    );
    expect(impacts.length).toBeGreaterThan(0);

    let maxSyncErrorMs = 0;
    for (const impact of impacts) {
      const targetTime = targetTimeById.get(impact.hitsTarget!);
      expect(targetTime).toBeDefined();
      const errorMs = Math.abs(impact.tSec - targetTime!) * 1000;
      maxSyncErrorMs = Math.max(maxSyncErrorMs, errorMs);
      expect(errorMs).toBeLessThanOrEqual(SYNC_TOLERANCE_MS);
    }
    expect(maxSyncErrorMs).toBeLessThanOrEqual(SYNC_TOLERANCE_MS);

    // Stage D output-boundary validator accepts the trajectory.
    expect(() =>
      validateObjectTrajectory(trajectory, targets, SYNC_TOLERANCE_MS),
    ).not.toThrow();
  });

  it('end-to-end - impacts correspond to the reachable mapped targets', () => {
    const targetIds = new Set(targets.map((target) => target.noteId));
    const impactIds = trajectory.keyframes
      .filter((keyframe) => keyframe.hitsTarget !== undefined)
      .map((keyframe) => keyframe.hitsTarget!);

    // Every impact references a real, mapped target.
    for (const id of impactIds) {
      expect(targetIds.has(id)).toBe(true);
    }

    // These well-spaced targets are all reachable, so each is hit exactly once
    // and none are skipped.
    const uniqueImpactIds = new Set(impactIds);
    expect(uniqueImpactIds.size).toBe(impactIds.length);
    expect(uniqueImpactIds.size).toBe(targetIds.size);
  });

  it('reports observed pipeline metrics for the checkpoint record', () => {
    const impacts = trajectory.keyframes.filter(
      (keyframe) => keyframe.hitsTarget !== undefined,
    );
    const targetTimeById = new Map(
      targets.map((target) => [target.noteId, target.timeSec] as const),
    );
    const maxSyncErrorMs = impacts.reduce((worst, impact) => {
      const targetTime = targetTimeById.get(impact.hitsTarget!) ?? impact.tSec;
      return Math.max(worst, Math.abs(impact.tSec - targetTime) * 1000);
    }, 0);

    // Surface the numbers the checkpoints ask for in the test output.
    console.log(
      `[pipeline.integration] notes=${notes.length} targets=${targets.length} ` +
        `keyframes=${trajectory.keyframes.length} impacts=${impacts.length} ` +
        `maxSyncErrorMs=${maxSyncErrorMs.toExponential(3)}`,
    );

    expect(impacts.length).toBe(targets.length);
  });
});
