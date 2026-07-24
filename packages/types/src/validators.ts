// Runtime validators for the MotionScore data contracts.
//
// `validateNoteEvents` enforces the invariants documented on {@link NoteEvent}
// and throws a `ValidationError` — carrying the stage, the offending field
// path, and the actual value — on the first violation, so a bug surfaces as a
// precise, actionable error instead of silent corruption downstream.

import type { NoteEvent } from './data-contracts.js';
import { ValidationError } from './errors.js';

/** Stage label recorded in `ValidationError.stage`. */
const STAGE_NOTE_EVENT = 'Analysis (NoteEvent)';

/** Supported hit roles, used by the role field validator (single source of truth). */
const HIT_ROLE_VALUES: readonly string[] = [
  'kick',
  'bass',
  'snare',
  'percussion',
  'melodic',
  'vocal',
  'piano',
  'guitar',
];

/** True when `value` is a real, finite number (rejects `NaN` and `±Infinity`). */
function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Validate a `NoteEvent[]` produced by the analyzer against its data-contract
 * invariants (see {@link NoteEvent}).
 *
 * Checks, for every event:
 * - `id` is a non-empty string and unique within the array
 * - `pitchMidi` is an integer in [0, 127]
 * - `startSec` is finite and >= 0
 * - `endSec` is finite and strictly greater than `startSec`
 * - `velocity` is in [0.0, 1.0]
 * - optional `source` is `'audio'`, `role` is a supported role, and
 *   `confidence` / `salience` are in [0, 1]
 *
 * An empty array is vacuously valid; the "no events" case is an input-stage
 * concern reported by the analyzer, not a contract violation here.
 *
 * @throws {ValidationError} on the first violation, identifying the offending
 *   field (e.g. `events[3].pitchMidi`) and its actual value.
 */
export function validateNoteEvents(events: NoteEvent[]): void {
  const seenIds = new Set<string>();

  for (const [i, event] of events.entries()) {
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new ValidationError(STAGE_NOTE_EVENT, `events[${i}].id`, event.id);
    }
    if (seenIds.has(event.id)) {
      throw new ValidationError(
        STAGE_NOTE_EVENT,
        `events[${i}].id`,
        event.id,
        `Validation failed at ${STAGE_NOTE_EVENT}: duplicate id ${JSON.stringify(event.id)}`,
      );
    }
    seenIds.add(event.id);

    if (
      !Number.isInteger(event.pitchMidi) ||
      event.pitchMidi < 0 ||
      event.pitchMidi > 127
    ) {
      throw new ValidationError(
        STAGE_NOTE_EVENT,
        `events[${i}].pitchMidi`,
        event.pitchMidi,
      );
    }
    if (!isFiniteNumber(event.startSec) || event.startSec < 0) {
      throw new ValidationError(
        STAGE_NOTE_EVENT,
        `events[${i}].startSec`,
        event.startSec,
      );
    }
    if (!isFiniteNumber(event.endSec) || event.endSec <= event.startSec) {
      throw new ValidationError(
        STAGE_NOTE_EVENT,
        `events[${i}].endSec`,
        event.endSec,
      );
    }
    if (!(event.velocity >= 0 && event.velocity <= 1)) {
      throw new ValidationError(
        STAGE_NOTE_EVENT,
        `events[${i}].velocity`,
        event.velocity,
      );
    }

    if (event.source !== undefined && event.source !== 'audio') {
      throw new ValidationError(STAGE_NOTE_EVENT, `events[${i}].source`, event.source);
    }
    if (event.role !== undefined && !HIT_ROLE_VALUES.includes(event.role)) {
      throw new ValidationError(STAGE_NOTE_EVENT, `events[${i}].role`, event.role);
    }
    if (
      event.confidence !== undefined &&
      (!isFiniteNumber(event.confidence) || event.confidence < 0 || event.confidence > 1)
    ) {
      throw new ValidationError(
        STAGE_NOTE_EVENT,
        `events[${i}].confidence`,
        event.confidence,
      );
    }
    if (
      event.salience !== undefined &&
      (!isFiniteNumber(event.salience) || event.salience < 0 || event.salience > 1)
    ) {
      throw new ValidationError(
        STAGE_NOTE_EVENT,
        `events[${i}].salience`,
        event.salience,
      );
    }
  }
}
