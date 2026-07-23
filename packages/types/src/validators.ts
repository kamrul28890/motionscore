// Runtime validators for the MotionScore pipeline data contracts.
//
// Each validator enforces the invariants documented on the corresponding
// data-contract interface (see `data-contracts.ts`) and throws a
// `ValidationError` — carrying the pipeline stage, the offending field path,
// and the actual value — on the first violation. Validators run at pipeline
// stage boundaries so a bug in one stage surfaces as a precise, actionable
// error instead of silent corruption downstream (Requirement 8).

import type {
  Choreography,
  ChoreographyTarget,
  NoteEvent,
  ObjectTrajectory,
} from './data-contracts.js';
import { ValidationError } from './errors.js';

/** Stage labels recorded in `ValidationError.stage`. */
const STAGE_NOTE_EVENT = 'Stage B (NoteEvent)';
const STAGE_CHOREOGRAPHY_TARGET = 'Stage C (ChoreographyTarget)';
const STAGE_OBJECT_TRAJECTORY = 'Stage D (ObjectTrajectory)';
const STAGE_CHOREOGRAPHY = 'Stage C/D (Choreography)';

/** Supported hit roles, used by several field validators. */
const HIT_ROLE_VALUES: readonly string[] = [
  'kick',
  'bass',
  'snare',
  'percussion',
  'melodic',
];

/**
 * Matches CSS-style hex colors: `#RGB`, `#RGBA`, `#RRGGBB`, or `#RRGGBBAA`.
 * The leading `#` is required and only hexadecimal digits are permitted.
 */
const HEX_COLOR_PATTERN =
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** True when `value` is a real, finite number (rejects `NaN` and `±Infinity`). */
function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Validate a `NoteEvent[]` produced by Stage B against its data-contract
 * invariants (see {@link NoteEvent}).
 *
 * Checks, for every event:
 * - `id` is a non-empty string and unique within the array
 * - `pitchMidi` is an integer in [0, 127]
 * - `startSec` is finite and >= 0
 * - `endSec` is finite and strictly greater than `startSec`
 * - `velocity` is in [0.0, 1.0]
 *
 * An empty array is vacuously valid; the "no notes" case is an input-stage
 * concern reported by the note extractor, not a contract violation here.
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

    if (
      event.source !== undefined &&
      event.source !== 'midi' &&
      event.source !== 'audio'
    ) {
      throw new ValidationError(STAGE_NOTE_EVENT, `events[${i}].source`, event.source);
    }
    if (
      event.role !== undefined &&
      !['kick', 'bass', 'snare', 'percussion', 'melodic'].includes(event.role)
    ) {
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

/**
 * Validate a `ChoreographyTarget[]` produced by Stage C against its
 * data-contract invariants (see {@link ChoreographyTarget}).
 *
 * Checks, for every target:
 * - `noteId` is a non-empty string
 * - `timeSec` is finite and >= 0
 * - `position.x` is in [0, `canvasWidth`] and `position.y` is in
 *   [0, `canvasHeight`]
 * - `impactSize` is in [0.0, 1.0]
 * - `colorHint` is a valid hex color string
 *
 * When the originating `noteEvents` are supplied, each `noteId` is additionally
 * checked to reference an existing note and each `timeSec` to match that note's
 * `startSec` (design.md: "timeSec must ... match the referenced note's
 * startSec"). Callers at the Stage C -> Stage D boundary have these notes and
 * should pass them for full validation; the check is skipped otherwise.
 *
 * @throws {ValidationError} on the first violation, identifying the offending
 *   field (e.g. `targets[2].position.x`) and its actual value.
 */
export function validateChoreographyTargets(
  targets: ChoreographyTarget[],
  canvasWidth: number,
  canvasHeight: number,
  noteEvents?: readonly NoteEvent[],
): void {
  const noteById = noteEvents
    ? new Map(noteEvents.map((note) => [note.id, note] as const))
    : undefined;

  for (const [i, target] of targets.entries()) {
    if (typeof target.noteId !== 'string' || target.noteId.length === 0) {
      throw new ValidationError(
        STAGE_CHOREOGRAPHY_TARGET,
        `targets[${i}].noteId`,
        target.noteId,
      );
    }

    if (!isFiniteNumber(target.timeSec) || target.timeSec < 0) {
      throw new ValidationError(
        STAGE_CHOREOGRAPHY_TARGET,
        `targets[${i}].timeSec`,
        target.timeSec,
      );
    }

    const { x, y } = target.position;
    if (!(x >= 0 && x <= canvasWidth)) {
      throw new ValidationError(
        STAGE_CHOREOGRAPHY_TARGET,
        `targets[${i}].position.x`,
        x,
      );
    }
    if (!(y >= 0 && y <= canvasHeight)) {
      throw new ValidationError(
        STAGE_CHOREOGRAPHY_TARGET,
        `targets[${i}].position.y`,
        y,
      );
    }

    if (!(target.impactSize >= 0 && target.impactSize <= 1)) {
      throw new ValidationError(
        STAGE_CHOREOGRAPHY_TARGET,
        `targets[${i}].impactSize`,
        target.impactSize,
      );
    }

    if (
      typeof target.colorHint !== 'string' ||
      !HEX_COLOR_PATTERN.test(target.colorHint)
    ) {
      throw new ValidationError(
        STAGE_CHOREOGRAPHY_TARGET,
        `targets[${i}].colorHint`,
        target.colorHint,
      );
    }

    if (
      target.role !== undefined &&
      !['kick', 'bass', 'snare', 'percussion', 'melodic'].includes(target.role)
    ) {
      throw new ValidationError(
        STAGE_CHOREOGRAPHY_TARGET,
        `targets[${i}].role`,
        target.role,
      );
    }

    if (noteById !== undefined) {
      const note = noteById.get(target.noteId);
      if (note === undefined) {
        throw new ValidationError(
          STAGE_CHOREOGRAPHY_TARGET,
          `targets[${i}].noteId`,
          target.noteId,
          `Validation failed at ${STAGE_CHOREOGRAPHY_TARGET}: noteId ${JSON.stringify(
            target.noteId,
          )} does not reference any NoteEvent`,
        );
      }
      if (target.timeSec !== note.startSec) {
        throw new ValidationError(
          STAGE_CHOREOGRAPHY_TARGET,
          `targets[${i}].timeSec`,
          target.timeSec,
          `Validation failed at ${STAGE_CHOREOGRAPHY_TARGET}: timeSec ${target.timeSec} does not match referenced note ${JSON.stringify(
            target.noteId,
          )} startSec ${note.startSec}`,
        );
      }
    }
  }
}

/**
 * Validate an `ObjectTrajectory` produced by Stage D against its data-contract
 * invariants (see {@link ObjectTrajectory}).
 *
 * Checks:
 * - every keyframe `tSec` is finite
 * - keyframes are strictly ascending by `tSec`
 * - every impact keyframe (`hitsTarget` set) references an existing target and
 *   lands within `toleranceMs` of that target's `timeSec`
 *
 * Physical (SUVAT/gravity) consistency between keyframes is intentionally out
 * of scope here: it depends on the solver's gravity constant, which is not part
 * of this boundary's inputs.
 *
 * @param toleranceMs Maximum allowed timing error, in milliseconds, between an
 *   impact keyframe and its referenced target (the solver's `syncToleranceMs`).
 * @throws {ValidationError} on the first violation, identifying the offending
 *   field (e.g. `keyframes[5].tSec`) and its actual value.
 */
export function validateObjectTrajectory(
  trajectory: ObjectTrajectory,
  targets: ChoreographyTarget[],
  toleranceMs: number,
): void {
  const targetById = new Map<string, ChoreographyTarget>();
  for (const target of targets) {
    targetById.set(target.noteId, target);
  }

  const toleranceSec = toleranceMs / 1000;
  let previousTSec: number | undefined;

  for (const [i, keyframe] of trajectory.keyframes.entries()) {
    if (!isFiniteNumber(keyframe.tSec)) {
      throw new ValidationError(
        STAGE_OBJECT_TRAJECTORY,
        `keyframes[${i}].tSec`,
        keyframe.tSec,
      );
    }

    if (previousTSec !== undefined && keyframe.tSec <= previousTSec) {
      throw new ValidationError(
        STAGE_OBJECT_TRAJECTORY,
        `keyframes[${i}].tSec`,
        keyframe.tSec,
        `Validation failed at ${STAGE_OBJECT_TRAJECTORY}: keyframes must strictly ascend by tSec; keyframes[${i}].tSec (${keyframe.tSec}) <= keyframes[${
          i - 1
        }].tSec (${previousTSec})`,
      );
    }
    previousTSec = keyframe.tSec;

    if (keyframe.hitsTarget !== undefined) {
      const target = targetById.get(keyframe.hitsTarget);
      if (target === undefined) {
        throw new ValidationError(
          STAGE_OBJECT_TRAJECTORY,
          `keyframes[${i}].hitsTarget`,
          keyframe.hitsTarget,
          `Validation failed at ${STAGE_OBJECT_TRAJECTORY}: hitsTarget ${JSON.stringify(
            keyframe.hitsTarget,
          )} does not reference any ChoreographyTarget`,
        );
      }
      if (Math.abs(keyframe.tSec - target.timeSec) > toleranceSec) {
        throw new ValidationError(
          STAGE_OBJECT_TRAJECTORY,
          `keyframes[${i}].tSec`,
          keyframe.tSec,
          `Validation failed at ${STAGE_OBJECT_TRAJECTORY}: impact keyframes[${i}].tSec (${keyframe.tSec}) is not within ${toleranceMs}ms of target ${JSON.stringify(
            keyframe.hitsTarget,
          )} timeSec (${target.timeSec})`,
        );
      }
    }
  }
}

/**
 * Validate a multi-voice {@link Choreography}: each voice's identity fields plus
 * its targets and trajectory, reusing {@link validateChoreographyTargets} and
 * {@link validateObjectTrajectory} per voice.
 *
 * A single-ball choreography (`voices.length === 1`) is the common case and is
 * held to exactly the same per-voice contracts.
 *
 * @throws {ValidationError} on the first violation, identifying the offending
 *   voice and field (e.g. `voices[1].colorHint`).
 */
export function validateChoreography(
  choreography: Choreography,
  canvasWidth: number,
  canvasHeight: number,
  toleranceMs: number,
  noteEvents?: readonly NoteEvent[],
): void {
  if (!isFiniteNumber(choreography.durationSec) || choreography.durationSec < 0) {
    throw new ValidationError(
      STAGE_CHOREOGRAPHY,
      'durationSec',
      choreography.durationSec,
    );
  }
  if (!Array.isArray(choreography.voices) || choreography.voices.length === 0) {
    throw new ValidationError(
      STAGE_CHOREOGRAPHY,
      'voices',
      choreography.voices,
      `Validation failed at ${STAGE_CHOREOGRAPHY}: a choreography must contain at least one voice`,
    );
  }

  const seenVoiceIds = new Set<string>();
  for (const [i, voice] of choreography.voices.entries()) {
    if (typeof voice.id !== 'string' || voice.id.length === 0) {
      throw new ValidationError(STAGE_CHOREOGRAPHY, `voices[${i}].id`, voice.id);
    }
    if (seenVoiceIds.has(voice.id)) {
      throw new ValidationError(
        STAGE_CHOREOGRAPHY,
        `voices[${i}].id`,
        voice.id,
        `Validation failed at ${STAGE_CHOREOGRAPHY}: duplicate voice id ${JSON.stringify(voice.id)}`,
      );
    }
    seenVoiceIds.add(voice.id);

    if (voice.role !== undefined && !HIT_ROLE_VALUES.includes(voice.role)) {
      throw new ValidationError(STAGE_CHOREOGRAPHY, `voices[${i}].role`, voice.role);
    }
    if (typeof voice.colorHint !== 'string' || !HEX_COLOR_PATTERN.test(voice.colorHint)) {
      throw new ValidationError(
        STAGE_CHOREOGRAPHY,
        `voices[${i}].colorHint`,
        voice.colorHint,
      );
    }
    if (
      !Array.isArray(voice.startPosition) ||
      voice.startPosition.length !== 2 ||
      !isFiniteNumber(voice.startPosition[0]) ||
      !isFiniteNumber(voice.startPosition[1])
    ) {
      throw new ValidationError(
        STAGE_CHOREOGRAPHY,
        `voices[${i}].startPosition`,
        voice.startPosition,
      );
    }

    // Per-voice targets and trajectory are held to the same contracts as the
    // single-ball path.
    validateChoreographyTargets(voice.targets, canvasWidth, canvasHeight, noteEvents);
    validateObjectTrajectory(voice.trajectory, voice.targets, toleranceMs);
  }
}
