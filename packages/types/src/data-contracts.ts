// Pipeline data contracts for MotionScore.
//
// These interfaces describe the typed payloads that flow between pipeline
// stages: NoteEvent (Stage B) -> ChoreographyTarget (Stage C) ->
// TrajectoryKeyframe/ObjectTrajectory (Stage D). Each type documents the
// runtime validation rules enforced by the validators in task 1.3.

/**
 * A single musical note produced by the note-extraction stage (Stage B).
 *
 * Validation rules (enforced by `validateNoteEvents`):
 * - `pitchMidi` must be an integer in [0, 127]
 * - `startSec` must be >= 0
 * - `endSec` must be > `startSec`
 * - `velocity` must be in [0.0, 1.0]
 * - `id` must be non-empty and unique within the array
 */
export interface NoteEvent {
  /** Unique identifier within the extracted array (e.g. `'n0001'`). */
  id: string;
  /** MIDI note number in [0, 127]. */
  pitchMidi: number;
  /** Onset time in seconds (>= 0). */
  startSec: number;
  /** Offset time in seconds (> `startSec`). */
  endSec: number;
  /** Normalized loudness in [0.0, 1.0] (MIDI velocity / 127). */
  velocity: number;
  /** Optional source track name (e.g. `'melody'`). */
  track?: string;
  /** Optional instrument name (e.g. `'piano'`). */
  instrument?: string;
}

/**
 * A positioned, timed target the physics object must strike, produced by the
 * musical-mapping stage (Stage C).
 *
 * Validation rules (enforced by `validateChoreographyTargets`):
 * - `noteId` must reference an existing NoteEvent
 * - `timeSec` must be >= 0 and match the referenced note's `startSec`
 * - `position.x` in [0, canvasWidth], `position.y` in [0, canvasHeight]
 * - `impactSize` must be in [0.0, 1.0]
 * - `colorHint` must be a valid hex color string
 */
export interface ChoreographyTarget {
  /** References the originating `NoteEvent.id`. */
  noteId: string;
  /** Exact time (seconds) the target must be hit. */
  timeSec: number;
  /** Target location in world coordinates. */
  position: { x: number; y: number };
  /** Impact magnitude in [0.0, 1.0], derived from note velocity. */
  impactSize: number;
  /** Hex color for the target/impact (e.g. `'#4477ff'`). */
  colorHint: string;
}

/**
 * A time-stamped position/velocity snapshot of the physics object, produced by
 * the trajectory-solving stage (Stage D).
 *
 * Validation rules (enforced by `validateObjectTrajectory`):
 * - keyframes must be strictly ascending by `tSec`
 * - if `hitsTarget` is set, `tSec` must be within the sync tolerance of the
 *   referenced target's `timeSec`
 */
export interface TrajectoryKeyframe {
  /** Time of this keyframe in seconds. */
  tSec: number;
  /** Position as `[x, y]`. */
  pos: [number, number];
  /** Velocity as `[vx, vy]`. */
  vel: [number, number];
  /** Set to the `noteId` this keyframe impacts, when it is an impact frame. */
  hitsTarget?: string;
}

/**
 * The complete motion of a single object: an ordered sequence of keyframes.
 */
export interface ObjectTrajectory {
  /** Object identifier (e.g. `'ball_01'`). */
  objectId: string;
  /** Keyframes ordered by strictly ascending `tSec`. */
  keyframes: TrajectoryKeyframe[];
}
