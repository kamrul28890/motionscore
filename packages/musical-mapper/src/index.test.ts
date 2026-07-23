// Property-based tests for the musical mapper (task 3.3), Stage C.
//
// Covers five design correctness properties:
//   - Property 5 (Pitch-to-position monotonicity)   — Requirement 3.1
//   - Property 6 (Choreography target bounds)        — Requirements 3.2, 3.3
//   - Property 7 (Velocity-to-impact monotonicity)   — Requirement 3.3
//   - Property 8 (Pitch class color consistency)     — Requirement 3.4
//   - Property 9 (Musical mapper output ordering)    — Requirement 3.6
//
// Implementation sources are imported from `./index.js` so tests run against
// the current TypeScript rather than a possibly-stale `dist/`. The shared type
// contracts come from `@motionscore/types` as type-only imports (erased at
// runtime, so no built artifact is required to resolve them here).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import type { LayoutConfig, NoteEvent } from '@motionscore/types';
import {
  mapNotes,
  pitchToColor,
  pitchToX,
  velocityToImpactSize,
} from './index.js';

// --- Shared constants -------------------------------------------------------

/** MIDI note numbers span [0, 127]. */
const MIDI_MIN = 0;
const MIDI_MAX = 127;
/** Semitones per octave; a pitch and P+12 share a pitch class. */
const OCTAVE = 12;

// --- Shared arbitraries -----------------------------------------------------

/**
 * A valid pitch range `[minPitch, maxPitch]` with `minPitch < maxPitch`.
 * `maxPitch` is `minPitch + span` capped at 127; because `minPitch <= 126` and
 * `span >= 1`, the cap can never collapse the range to a single point.
 */
const pitchRangeArb: fc.Arbitrary<[number, number]> = fc
  .tuple(fc.integer({ min: 0, max: 126 }), fc.integer({ min: 1, max: 127 }))
  .map(([minPitch, span]): [number, number] => [
    minPitch,
    Math.min(MIDI_MAX, minPitch + span),
  ]);

/** The randomized part of a valid NoteEvent (id/endSec derived on assembly). */
interface NoteBody {
  readonly pitchMidi: number;
  readonly startSec: number;
  readonly duration: number;
  readonly velocity: number;
}

/**
 * A single valid note body. Ranges satisfy the NoteEvent contract:
 * pitchMidi integer in [0, 127]; startSec finite and >= 0; duration >= 0.001 so
 * `endSec = startSec + duration` is strictly greater than startSec at these
 * scales; velocity finite in [0.0, 1.0].
 */
const noteBodyArb: fc.Arbitrary<NoteBody> = fc.record({
  pitchMidi: fc.integer({ min: MIDI_MIN, max: MIDI_MAX }),
  startSec: fc.double({ min: 0, max: 1_000, noNaN: true }),
  duration: fc.double({ min: 0.001, max: 1_000, noNaN: true }),
  velocity: fc.double({ min: 0, max: 1, noNaN: true }),
});

/** Assemble note bodies into valid NoteEvents with unique, non-empty ids. */
function toNoteEvents(bodies: readonly NoteBody[]): NoteEvent[] {
  return bodies.map((body, i) => ({
    id: `n${i}`,
    pitchMidi: body.pitchMidi,
    startSec: body.startSec,
    endSec: body.startSec + body.duration,
    velocity: body.velocity,
  }));
}

/** Non-empty valid NoteEvent arrays (mapNotes precondition: non-empty input). */
const noteEventsArb: fc.Arbitrary<NoteEvent[]> = fc
  .array(noteBodyArb, { minLength: 1, maxLength: 32 })
  .map(toNoteEvents);

/**
 * A valid `LayoutConfig`: positive canvas dimensions, a target row within the
 * canvas height, and a valid pitch range. These are exactly the preconditions
 * `mapNotes` requires, so it maps (and internally validates) without throwing.
 */
const layoutConfigArb: fc.Arbitrary<LayoutConfig> = fc
  .record({
    canvasWidth: fc.integer({ min: 1, max: 4_000 }),
    canvasHeight: fc.integer({ min: 1, max: 4_000 }),
    targetYFrac: fc.double({ min: 0, max: 1, noNaN: true }),
    pitchRange: pitchRangeArb,
  })
  .map(
    ({ canvasWidth, canvasHeight, targetYFrac, pitchRange }): LayoutConfig => ({
      type: 'piano-keys',
      canvasWidth,
      canvasHeight,
      // In [0, canvasHeight] so the target row is always within bounds.
      targetY: targetYFrac * canvasHeight,
      pitchRange,
      colorScheme: 'circle-of-fifths',
    }),
  );

/** True when `values` is non-decreasing (each element >= its predecessor). */
function isNonDecreasing(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    const prev = values[i - 1];
    const curr = values[i];
    // Indices 1..length-1 are in range; the undefined guard only satisfies
    // noUncheckedIndexedAccess and never changes the result.
    if (prev !== undefined && curr !== undefined && prev > curr) {
      return false;
    }
  }
  return true;
}

// --- Property 5: pitch-to-position monotonicity -----------------------------

describe('pitchToX — Property 5: pitch-to-position monotonicity', () => {
  // **Validates: Requirements 3.1**
  it('never maps a higher pitch to a smaller x than a lower pitch', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MIDI_MIN, max: MIDI_MAX }),
        fc.integer({ min: MIDI_MIN, max: MIDI_MAX }),
        fc.integer({ min: 1, max: 4_000 }),
        pitchRangeArb,
        (pitchA, pitchB, canvasWidth, pitchRange) => {
          const lo = Math.min(pitchA, pitchB);
          const hi = Math.max(pitchA, pitchB);
          const xLo = pitchToX(lo, canvasWidth, pitchRange);
          const xHi = pitchToX(hi, canvasWidth, pitchRange);
          // Monotonically non-decreasing in pitch.
          expect(xLo).toBeLessThanOrEqual(xHi);
          // ...and always within [0, canvasWidth].
          for (const x of [xLo, xHi]) {
            expect(x).toBeGreaterThanOrEqual(0);
            expect(x).toBeLessThanOrEqual(canvasWidth);
          }
        },
      ),
    );
  });
});

// --- Property 6: choreography target bounds preservation --------------------

describe('mapNotes — Property 6: choreography target bounds preservation', () => {
  // **Validates: Requirements 3.2, 3.3**
  it('keeps every target position and impactSize within bounds', () => {
    fc.assert(
      fc.property(noteEventsArb, layoutConfigArb, (notes, config) => {
        const targets = mapNotes(notes, config);
        for (const target of targets) {
          expect(target.position.x).toBeGreaterThanOrEqual(0);
          expect(target.position.x).toBeLessThanOrEqual(config.canvasWidth);
          expect(target.position.y).toBeGreaterThanOrEqual(0);
          expect(target.position.y).toBeLessThanOrEqual(config.canvasHeight);
          expect(target.impactSize).toBeGreaterThanOrEqual(0);
          expect(target.impactSize).toBeLessThanOrEqual(1);
        }
      }),
    );
  });
});

// --- Property 7: velocity-to-impact monotonicity and normalization ----------

describe('velocityToImpactSize — Property 7: velocity-to-impact monotonicity', () => {
  // **Validates: Requirements 3.3**
  it('is monotonically non-decreasing and stays within [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (vA, vB) => {
          const lo = Math.min(vA, vB);
          const hi = Math.max(vA, vB);
          const impactLo = velocityToImpactSize(lo);
          const impactHi = velocityToImpactSize(hi);
          expect(impactLo).toBeLessThanOrEqual(impactHi);
          for (const size of [impactLo, impactHi]) {
            expect(size).toBeGreaterThanOrEqual(0);
            expect(size).toBeLessThanOrEqual(1);
          }
        },
      ),
    );
  });
});

// --- Property 8: pitch class color consistency ------------------------------

describe('pitchToColor — Property 8: pitch class color consistency', () => {
  // **Validates: Requirements 3.4**
  it('assigns a pitch and its octave (P and P+12) the same color', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: MIDI_MIN, max: MIDI_MAX - OCTAVE }),
        (pitch) => {
          expect(pitchToColor(pitch)).toBe(pitchToColor(pitch + OCTAVE));
        },
      ),
    );
  });
});

// --- Property 9: musical mapper output ordering -----------------------------

describe('mapNotes — Property 9: output ordering', () => {
  // **Validates: Requirements 3.6**
  it('returns targets sorted by timeSec ascending', () => {
    fc.assert(
      fc.property(noteEventsArb, layoutConfigArb, (notes, config) => {
        const targets = mapNotes(notes, config);
        expect(isNonDecreasing(targets.map((target) => target.timeSec))).toBe(
          true,
        );
      }),
    );
  });
});

// --- Unit tests: representative examples and edge cases ---------------------

describe('musical mapper — examples and edge cases', () => {
  it('pitchToX clamps out-of-range pitches into [0, canvasWidth]', () => {
    const width = 1_000;
    const range: [number, number] = [36, 96];
    expect(pitchToX(36, width, range)).toBe(0); // at min -> 0
    expect(pitchToX(96, width, range)).toBe(width); // at max -> width
    expect(pitchToX(20, width, range)).toBe(0); // below min clamps to 0
    expect(pitchToX(120, width, range)).toBe(width); // above max clamps to width
    expect(pitchToX(66, width, range)).toBe(500); // midpoint -> half width
  });

  it('velocityToImpactSize passes velocity through unchanged', () => {
    expect(velocityToImpactSize(0)).toBe(0);
    expect(velocityToImpactSize(0.5)).toBe(0.5);
    expect(velocityToImpactSize(1)).toBe(1);
  });

  it('pitchToColor gives every octave of a pitch class the same color', () => {
    for (const cNote of [12, 24, 36, 120]) {
      expect(pitchToColor(cNote)).toBe(pitchToColor(0));
    }
    // A different pitch class need not share the color.
    expect(pitchToColor(1)).not.toBe(pitchToColor(0));
  });

  it('mapNotes sorts unsorted notes by time and preserves note ids', () => {
    const notes: NoteEvent[] = [
      { id: 'a', pitchMidi: 60, startSec: 2, endSec: 2.5, velocity: 0.9 },
      { id: 'b', pitchMidi: 72, startSec: 0.5, endSec: 1, velocity: 0.2 },
      { id: 'c', pitchMidi: 48, startSec: 1, endSec: 1.5, velocity: 0.5 },
    ];
    const config: LayoutConfig = {
      type: 'piano-keys',
      canvasWidth: 1_920,
      canvasHeight: 1_080,
      targetY: 900,
      pitchRange: [36, 96],
    };
    const targets = mapNotes(notes, config);
    expect(targets.map((target) => target.timeSec)).toEqual([0.5, 1, 2]);
    expect(targets.map((target) => target.noteId)).toEqual(['b', 'c', 'a']);
  });

  it('mapNotes returns an empty array for empty input', () => {
    const config: LayoutConfig = {
      type: 'piano-keys',
      canvasWidth: 800,
      canvasHeight: 600,
      targetY: 500,
      pitchRange: [21, 108],
    };
    expect(mapNotes([], config)).toEqual([]);
  });
});

// --- planVoices (multi-ball voice planning, Phase 1) ------------------------

import { planVoices } from './index.js';
import type { ChoreographyTarget, HitRole } from '@motionscore/types';

/** Minimal layout config for voice-planning tests. */
const voiceLayout: LayoutConfig = {
  type: 'lanes',
  canvasWidth: 1920,
  canvasHeight: 1080,
  targetY: 900,
};

/** Build a ChoreographyTarget with an optional role at a given time. */
function target(noteId: string, timeSec: number, role?: HitRole): ChoreographyTarget {
  const t: ChoreographyTarget = {
    noteId,
    timeSec,
    position: { x: 960, y: 900 },
    impactSize: 0.5,
    colorHint: '#4477ff',
  };
  if (role !== undefined) t.role = role;
  return t;
}

describe('planVoices — voice partitioning (multi-ball Phase 1)', () => {
  it('single grouping yields one voice containing every target', () => {
    const targets = [target('n0001', 0.5, 'kick'), target('n0002', 1.0, 'snare')];
    const voices = planVoices(targets, 'single', voiceLayout);

    expect(voices).toHaveLength(1);
    expect(voices[0]!.id).toBe('voice_all');
    expect(voices[0]!.targets).toHaveLength(2);
    expect(voices[0]!.role).toBeUndefined();
    // Launched from canvas center, near the top (mirrors the legacy start).
    expect(voices[0]!.startPosition[0]).toBe(960);
    expect(voices[0]!.startPosition[1]).toBe(Math.round(1080 * (100 / 1080)));
  });

  it('per-role grouping produces one voice per distinct role, in fixed order', () => {
    const targets = [
      target('n0001', 0.5, 'snare'),
      target('n0002', 0.5, 'kick'),
      target('n0003', 1.0, 'kick'),
      target('n0004', 1.5, 'melodic'),
    ];
    const voices = planVoices(targets, 'per-role', voiceLayout);

    // kick, snare, melodic present → 3 voices, ordered kick < snare < melodic.
    expect(voices.map((v) => v.role)).toEqual(['kick', 'snare', 'melodic']);
    const kick = voices.find((v) => v.role === 'kick')!;
    expect(kick.targets.map((t) => t.noteId)).toEqual(['n0002', 'n0003']);
    // Distinct tints and distinct launch lanes per role.
    const xs = voices.map((v) => v.startPosition[0]);
    expect(new Set(xs).size).toBe(voices.length);
    expect(new Set(voices.map((v) => v.colorHint)).size).toBe(voices.length);
  });

  it('per-role falls back to a single voice when no target has a role (MIDI)', () => {
    const targets = [target('n0001', 0.5), target('n0002', 1.0)];
    const voices = planVoices(targets, 'per-role', voiceLayout);

    expect(voices).toHaveLength(1);
    expect(voices[0]!.id).toBe('voice_all');
  });

  it('per-role routes role-less targets into a single neutral "other" voice', () => {
    const targets = [target('n0001', 0.5, 'kick'), target('n0002', 1.0)];
    const voices = planVoices(targets, 'per-role', voiceLayout);

    expect(voices.map((v) => v.id).sort()).toEqual(['voice_kick', 'voice_other']);
    const other = voices.find((v) => v.id === 'voice_other')!;
    expect(other.role).toBeUndefined();
    expect(other.targets.map((t) => t.noteId)).toEqual(['n0002']);
  });

  it('does not mutate the input targets and preserves every target exactly once', () => {
    const targets = [
      target('n0001', 0.5, 'kick'),
      target('n0002', 1.0, 'bass'),
      target('n0003', 1.5, 'kick'),
    ];
    const before = JSON.stringify(targets);
    const voices = planVoices(targets, 'per-role', voiceLayout);

    expect(JSON.stringify(targets)).toBe(before);
    const distributed = voices.flatMap((v) => v.targets.map((t) => t.noteId)).sort();
    expect(distributed).toEqual(['n0001', 'n0002', 'n0003']);
  });

  it('handles empty input as one empty voice', () => {
    const voices = planVoices([], 'per-role', voiceLayout);
    expect(voices).toHaveLength(1);
    expect(voices[0]!.targets).toHaveLength(0);
  });
});
