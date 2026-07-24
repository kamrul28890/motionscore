// Pipeline data contracts for MotionScore.
//
// These interfaces describe the typed payloads that flow between pipeline
// stages: NoteEvent (Stage B) -> ChoreographyTarget (Stage C) ->
// TrajectoryKeyframe/ObjectTrajectory (Stage D). Each type documents the
// runtime validation rules enforced by the validators in task 1.3.

/**
 * Musical role assigned to a hit. The first five come from the lightweight
 * frequency-band analyzer; `vocal` / `piano` / `guitar` are produced by the
 * neural stem analyzer (Demucs `htdemucs_6s`), which isolates real instruments.
 */
export type HitRole =
  | 'kick'
  | 'bass'
  | 'snare'
  | 'percussion'
  | 'melodic'
  | 'vocal'
  | 'piano'
  | 'guitar';

/**
 * Canonical display order for roles: the percussion cluster first, then pitched
 * instruments. Used by the analysis UI and anywhere roles are enumerated.
 */
export const ROLE_ORDER: readonly HitRole[] = [
  'kick',
  'snare',
  'percussion',
  'bass',
  'melodic',
  'piano',
  'guitar',
  'vocal',
];

/**
 * Canonical ball tint per role — the single source of truth shared by the
 * mapper (each per-role ball's `colorHint`) and the web analysis panel legend,
 * so a role's swatch always matches its ball in the rendered video.
 */
export const ROLE_COLORS: Record<HitRole, string> = {
  kick: '#ff6b6b',
  bass: '#ffa94d',
  snare: '#ffd43b',
  percussion: '#63e6be',
  melodic: '#4dabf7',
  piano: '#b197fc',
  guitar: '#f783ac',
  vocal: '#a9e34b',
};

/** Human-friendly instrument label per role (for UI and ball labels). */
export const ROLE_LABELS: Record<HitRole, string> = {
  kick: 'Kick',
  bass: 'Bass',
  snare: 'Snare',
  percussion: 'Percussion',
  melodic: 'Melody',
  piano: 'Piano',
  guitar: 'Guitar',
  vocal: 'Vocals',
};

/**
 * Number of time bins in {@link AudioAnalysisSummary.roleActivity}. A fixed
 * count keeps the payload small and the UI layout stable regardless of song
 * length.
 */
export const ROLE_ACTIVITY_BINS = 56;

/**
 * Analyzer strategies that produce rhythmic events from an audio waveform.
 * `stems` is the neural per-instrument analyzer (Demucs source separation);
 * the others are librosa-based.
 */
export type AudioAnalysisMode = 'smart' | 'beats' | 'onsets' | 'stems';

/**
 * A single musical note or salient audio hit produced by Stage B.
 *
 * Validation rules (enforced by `validateNoteEvents`):
 * - `pitchMidi` must be an integer in [0, 127]
 * - `startSec` must be >= 0
 * - `endSec` must be > `startSec`
 * - `velocity`, optional `confidence`, and optional `salience` are in [0, 1]
 * - optional `source` is `'midi'` or `'audio'`
 * - optional `role` is a supported {@link HitRole}
 * - `id` must be non-empty and unique within the array
 */
export interface NoteEvent {
  /** Unique identifier within the extracted array (e.g. `'n0001'`). */
  id: string;
  /** MIDI note number in [0, 127], or a stable position hint for audio hits. */
  pitchMidi: number;
  /** Onset time in seconds (>= 0). */
  startSec: number;
  /** Offset time in seconds (> `startSec`). */
  endSec: number;
  /** Normalized loudness/impact strength in [0.0, 1.0]. */
  velocity: number;
  /** Origin discriminator; audio enables choreography hints without affecting MIDI. */
  source?: 'midi' | 'audio';
  /** Optional musical role inferred for a mixed-audio attack. */
  role?: HitRole;
  /** Confidence in the inferred attack and role, in [0.0, 1.0]. */
  confidence?: number;
  /** Musical importance used by event selection, in [0.0, 1.0]. */
  salience?: number;
  /** Optional source track name (e.g. `'melody'`). */
  track?: string;
  /** Optional instrument name (e.g. `'piano'`). */
  instrument?: string;
}

/** Continuous normalized audio features sampled at a fixed analysis rate. */
export interface AudioFeatureFrame {
  timeSec: number;
  loudness: number;
  bassEnergy: number;
  brightness: number;
  onsetDensity: number;
  harmonicEnergy: number;
  percussiveEnergy: number;
}

/** Coarse local register motion for a pitched neural stem. */
export type PitchDirection = -1 | 0 | 1;

/** Inclusive start frame and exclusive end frame in a role-signal timeline. */
export type SustainSpan = [startFrame: number, endFrame: number];

/**
 * Compact continuous signal for one neural role. Activity is Q8 so a full song
 * can travel through the result API without an object for every role/frame.
 */
export interface RoleSignalTrack {
  role: HitRole;
  /** Per-frame activity, quantized from [0,1] to integer [0,255]. */
  activityQ8: number[];
  /** Sorted non-overlapping active regions on the shared frame grid. */
  sustainSpans: SustainSpan[];
  /** Rising/falling/level register motion; present for pitched roles only. */
  pitchDirection?: PitchDirection[];
  /** Fraction of active frames with a usable pitch estimate, in Q8. */
  pitchCoverageQ8?: number;
}

/** Per-role neural timelines aligned on one fixed-rate frame grid. */
export interface RoleSignals {
  version: 1;
  frameRateHz: number;
  frameCount: number;
  tracks: RoleSignalTrack[];
}

/** Structural scene cue inferred from a longer musical trend or transition. */
export interface SectionCue {
  type: 'build' | 'drop' | 'breakdown' | 'rise' | 'fall';
  startSec: number;
  endSec: number;
  peakSec?: number;
  intensity: number;
  confidence: number;
}

/** Rich audio-analysis result; `hits` remains compatible with the Stage B API. */
export interface AudioAnalysis {
  version: 1;
  durationSec: number;
  tempoBpm: number;
  mode: AudioAnalysisMode;
  hits: NoteEvent[];
  featureFrames: AudioFeatureFrame[];
  sectionCues: SectionCue[];
  /** Neural per-role activity/register timelines; present in stems mode. */
  roleSignals?: RoleSignals;
}

/** One downsampled point of the continuous energy timeline, for UI display. */
export interface AudioEnergySample {
  timeSec: number;
  loudness: number;
  bassEnergy: number;
}

/**
 * Compact, transport-friendly projection of an {@link AudioAnalysis} suitable
 * for sending to a UI. It drops the full-resolution feature frames in favor of
 * role counts and a downsampled energy timeline, so it stays small even for
 * long songs.
 */
export interface AudioAnalysisSummary {
  mode: AudioAnalysisMode;
  tempoBpm: number;
  durationSec: number;
  hitCount: number;
  roleCounts: Record<HitRole, number>;
  /**
   * Per-role activity over time. For each role, a {@link ROLE_ACTIVITY_BINS}-
   * length array of normalized `[0, 1]` intensity bins spanning
   * `[0, durationSec]`, so the UI can show *when* each instrument plays, not
   * just its total count. Each role is normalized against its own peak bin, so
   * the strip reveals an instrument's temporal pattern independent of absolute
   * loudness. Roles with no hits are all-zero.
   */
  roleActivity: Record<HitRole, number[]>;
  sectionCues: SectionCue[];
  energyTimeline: AudioEnergySample[];
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
  /** Musical role retained for role-aware layouts and future rendering. */
  role?: HitRole;
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

/**
 * How choreography targets are partitioned into independently-solved balls.
 * See `docs/MULTI_BALL_PLAN.md`.
 * - `'single'` — one ball hits every target (current default behavior).
 * - `'per-role'` — one ball per {@link HitRole} present in the targets; input
 *   without roles (MIDI, `notes` mode) falls back to a single voice.
 */
export type VoiceGrouping = 'single' | 'per-role';

/**
 * A ball assignment before solving: a subset of targets, a launch position, a
 * visual tint, and identity. Produced by the mapper's voice planner (Stage C);
 * the solver turns each plan into a full {@link Voice} by attaching a trajectory.
 */
export interface VoicePlan {
  /** Unique identifier within the choreography (e.g. `'voice_kick'`). */
  id: string;
  /** Human-readable label for UI/debugging (e.g. `'Kick'`, `'All hits'`). */
  label: string;
  /** Present for per-role voices; absent for the single combined voice. */
  role?: HitRole;
  /** Ball tint so multiple balls are visually distinct (hex color). */
  colorHint: string;
  /** Launch position of this ball as `[x, y]`. */
  startPosition: [number, number];
  /** The targets this ball is responsible for striking. */
  targets: ChoreographyTarget[];
}

/**
 * One independently-solved ball: a {@link VoicePlan} plus the trajectory that
 * hits its targets (Stage C/D).
 *
 * Validation rules (enforced by `validateChoreography`):
 * - `id` is non-empty and unique within the choreography
 * - optional `role` is a supported {@link HitRole}
 * - `colorHint` is a valid hex color string
 * - `startPosition` components are finite
 * - `targets` and `trajectory` satisfy their own contracts
 */
export interface Voice extends VoicePlan {
  /** The solved motion for this ball. */
  trajectory: ObjectTrajectory;
}

/**
 * A complete multi-ball choreography: one or more independently-solved
 * {@link Voice}s plus the overall content duration. Single-ball output is
 * simply `voices.length === 1`.
 */
export interface Choreography {
  /** Overall content duration in seconds (source-aware when available). */
  durationSec: number;
  /** One or more balls, each with its own targets and trajectory. */
  voices: Voice[];
}
