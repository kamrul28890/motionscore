// Tests for the MotionScore data-contract validators (packages/types).
//
// Property 12: Data contract validation correctness
// **Validates: Requirements 8.1**
//
// Requirement 8.1 says the pipeline SHALL validate NoteEvent arrays at the
// Stage B -> Stage C boundary: pitchMidi in [0, 127], startSec >= 0,
// endSec > startSec, velocity in [0.0, 1.0], non-empty unique id.
//
// Property 12 restated: for any NoteEvent array whose fields all satisfy those
// constraints, `validateNoteEvents` accepts (does not throw); for any array
// with at least one field violation, it rejects with a `ValidationError`.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import type { NoteEvent } from './data-contracts.js';
import { validateNoteEvents } from './validators.js';
import { ValidationError } from './errors.js';

// --- Shared arbitraries -----------------------------------------------------

/**
 * The randomized part of a valid NoteEvent. `id`/`endSec` are derived when the
 * body is assembled into a NoteEvent so contract invariants hold by
 * construction (unique ids, endSec > startSec).
 */
interface NoteBody {
  readonly pitchMidi: number;
  readonly startSec: number;
  readonly duration: number;
  readonly velocity: number;
}

/**
 * Generates a single valid note body. Ranges are constrained so every field
 * satisfies its contract:
 * - pitchMidi: integer in [0, 127]
 * - startSec: finite, in [0, 1000]
 * - duration: finite, >= 0.001 (so endSec = startSec + duration is strictly
 *   greater than startSec even after floating-point rounding at these scales)
 * - velocity: finite, in [0.0, 1.0]
 */
const noteBodyArb: fc.Arbitrary<NoteBody> = fc.record({
  pitchMidi: fc.integer({ min: 0, max: 127 }),
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

/** Valid NoteEvent arrays (including the empty array, which is vacuously valid). */
const validNoteEventsArb: fc.Arbitrary<NoteEvent[]> = fc
  .array(noteBodyArb, { maxLength: 24 })
  .map(toNoteEvents);

// A single field mutation that is guaranteed to violate exactly one rule.
type Corruption =
  | { readonly kind: 'pitchMidi'; readonly value: number }
  | { readonly kind: 'startSec'; readonly value: number }
  | { readonly kind: 'endSecLteStartSec' }
  | { readonly kind: 'velocity'; readonly value: number }
  | { readonly kind: 'emptyId' };

/** Apply a corruption to a single event, returning a new (invalid) event. */
function applyCorruption(event: NoteEvent, corruption: Corruption): NoteEvent {
  switch (corruption.kind) {
    case 'pitchMidi':
      return { ...event, pitchMidi: corruption.value };
    case 'startSec':
      return { ...event, startSec: corruption.value };
    case 'endSecLteStartSec':
      // endSec === startSec violates the strict endSec > startSec rule.
      return { ...event, endSec: event.startSec };
    case 'velocity':
      return { ...event, velocity: corruption.value };
    case 'emptyId':
      return { ...event, id: '' };
  }
}

/** pitchMidi values that are always invalid: out of [0,127] or non-integer. */
const invalidPitchArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 128, max: 10_000 }),
  fc.integer({ min: -10_000, max: -1 }),
  fc.integer({ min: 0, max: 126 }).map((n) => n + 0.5), // in-range but non-integer
);

/** startSec values that are always invalid: negative or non-finite. */
const invalidStartSecArb: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: -10_000, max: -0.001, noNaN: true }),
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ),
);

/** velocity values that are always invalid: outside [0.0, 1.0] or NaN. */
const invalidVelocityArb: fc.Arbitrary<number> = fc.oneof(
  fc.double({ min: 1.0001, max: 10_000, noNaN: true }),
  fc.double({ min: -10_000, max: -0.0001, noNaN: true }),
  fc.constantFrom(Number.NaN),
);

const corruptionArb: fc.Arbitrary<Corruption> = fc.oneof(
  invalidPitchArb.map((value) => ({ kind: 'pitchMidi', value }) as const),
  invalidStartSecArb.map((value) => ({ kind: 'startSec', value }) as const),
  fc.constant({ kind: 'endSecLteStartSec' } as const),
  invalidVelocityArb.map((value) => ({ kind: 'velocity', value }) as const),
  fc.constant({ kind: 'emptyId' } as const),
);

/**
 * A valid array with exactly one element corrupted so it violates a single
 * field rule (pitch, startSec, endSec, velocity, or empty id). All other
 * elements/fields remain valid, so the corrupted field is what triggers the
 * rejection.
 */
const invalidNoteEventsArb: fc.Arbitrary<NoteEvent[]> = fc
  .tuple(
    fc.array(noteBodyArb, { minLength: 1, maxLength: 24 }),
    fc.nat(),
    corruptionArb,
  )
  .map(([bodies, rawIndex, corruption]) => {
    const events = toNoteEvents(bodies);
    const idx = rawIndex % events.length;
    return events.map((event, i) =>
      i === idx ? applyCorruption(event, corruption) : event,
    );
  });

/**
 * A valid array (>= 2 elements) where two distinct positions share an id,
 * violating the uniqueness rule while keeping every id non-empty.
 */
const duplicateIdNoteEventsArb: fc.Arbitrary<NoteEvent[]> = fc
  .tuple(
    fc.array(noteBodyArb, { minLength: 2, maxLength: 24 }),
    fc.nat(),
    fc.nat(),
  )
  .map(([bodies, aRaw, bRaw]) => {
    const events = toNoteEvents(bodies);
    const i = aRaw % events.length;
    const jInit = bRaw % events.length;
    const j = jInit === i ? (jInit + 1) % events.length : jInit;
    const duplicatedId = `n${i}`; // matches the id assigned at position i
    return events.map((event, k) =>
      k === j ? { ...event, id: duplicatedId } : event,
    );
  });

// --- Property 12 ------------------------------------------------------------

describe('validateNoteEvents — Property 12: data contract validation correctness', () => {
  // **Validates: Requirements 8.1**
  it('accepts any NoteEvent array whose fields all satisfy the contract', () => {
    fc.assert(
      fc.property(validNoteEventsArb, (events) => {
        expect(() => validateNoteEvents(events)).not.toThrow();
      }),
    );
  });

  // **Validates: Requirements 8.1**
  it('rejects any NoteEvent array containing a single field violation', () => {
    fc.assert(
      fc.property(invalidNoteEventsArb, (events) => {
        expect(() => validateNoteEvents(events)).toThrow(ValidationError);
      }),
    );
  });

  // **Validates: Requirements 8.1**
  it('rejects arrays with duplicate ids', () => {
    fc.assert(
      fc.property(duplicateIdNoteEventsArb, (events) => {
        expect(() => validateNoteEvents(events)).toThrow(ValidationError);
      }),
    );
  });
});

// --- Unit tests: representative examples and boundaries ---------------------

describe('validateNoteEvents — examples and edge cases', () => {
  it('accepts an empty array (vacuously valid)', () => {
    expect(() => validateNoteEvents([])).not.toThrow();
  });

  it('accepts a representative valid array', () => {
    const events: NoteEvent[] = [
      { id: 'n0001', pitchMidi: 60, startSec: 0, endSec: 0.5, velocity: 0.8 },
      { id: 'n0002', pitchMidi: 64, startSec: 0.5, endSec: 1, velocity: 0.4 },
    ];
    expect(() => validateNoteEvents(events)).not.toThrow();
  });

  it('accepts boundary field values', () => {
    const events: NoteEvent[] = [
      { id: 'lo', pitchMidi: 0, startSec: 0, endSec: 0.001, velocity: 0 },
      { id: 'hi', pitchMidi: 127, startSec: 10, endSec: 20, velocity: 1 },
    ];
    expect(() => validateNoteEvents(events)).not.toThrow();
  });

  it.each([
    ['pitchMidi above range', { pitchMidi: 128 }],
    ['pitchMidi below range', { pitchMidi: -1 }],
    ['non-integer pitchMidi', { pitchMidi: 60.5 }],
    ['negative startSec', { startSec: -0.001 }],
    ['velocity above range', { velocity: 1.1 }],
    ['velocity below range', { velocity: -0.1 }],
  ])('rejects %s', (_label, override) => {
    const base: NoteEvent = {
      id: 'n0',
      pitchMidi: 60,
      startSec: 0,
      endSec: 1,
      velocity: 0.5,
    };
    expect(() => validateNoteEvents([{ ...base, ...override }])).toThrow(
      ValidationError,
    );
  });

  it('rejects endSec equal to startSec', () => {
    const events: NoteEvent[] = [
      { id: 'n0', pitchMidi: 60, startSec: 1, endSec: 1, velocity: 0.5 },
    ];
    expect(() => validateNoteEvents(events)).toThrow(ValidationError);
  });

  it('rejects endSec less than startSec', () => {
    const events: NoteEvent[] = [
      { id: 'n0', pitchMidi: 60, startSec: 2, endSec: 1, velocity: 0.5 },
    ];
    expect(() => validateNoteEvents(events)).toThrow(ValidationError);
  });

  it('rejects an empty id', () => {
    const events: NoteEvent[] = [
      { id: '', pitchMidi: 60, startSec: 0, endSec: 1, velocity: 0.5 },
    ];
    expect(() => validateNoteEvents(events)).toThrow(ValidationError);
  });

  it('rejects duplicate ids', () => {
    const events: NoteEvent[] = [
      { id: 'dup', pitchMidi: 60, startSec: 0, endSec: 1, velocity: 0.5 },
      { id: 'dup', pitchMidi: 62, startSec: 1, endSec: 2, velocity: 0.5 },
    ];
    expect(() => validateNoteEvents(events)).toThrow(ValidationError);
  });

  it('reports the offending stage, field, and value on failure', () => {
    const events: NoteEvent[] = [
      { id: 'n0', pitchMidi: 60, startSec: 0, endSec: 1, velocity: 0.5 },
      { id: 'n1', pitchMidi: 200, startSec: 1, endSec: 2, velocity: 0.5 },
    ];
    try {
      validateNoteEvents(events);
      expect.fail('expected validateNoteEvents to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      if (error instanceof ValidationError) {
        expect(error.stage).toContain('NoteEvent');
        expect(error.field).toBe('events[1].pitchMidi');
        expect(error.value).toBe(200);
      }
    }
  });
});
