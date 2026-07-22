// Configuration contracts for MotionScore pipeline stages.
//
// Each interface configures one stage: CLIOptions (entry point), LayoutConfig
// (musical mapper), SolverConfig (trajectory solver), RenderConfig (renderer),
// and ExportConfig (video exporter). Field names/shapes mirror the design.

/**
 * Parsed command-line options for the CLI entry point.
 */
export interface CLIOptions {
  /** Path to the input file (MIDI or audio). */
  input: string;
  /** Path to the output video file. */
  output: string;
  /** Target frame rate (default: 60). */
  fps?: number;
  /** Video width in pixels (default: 1920). */
  width?: number;
  /** Video height in pixels (default: 1080). */
  height?: number;
  /** Gravity constant (default: 9.81 * pixelsPerMeter). */
  gravity?: number;
  /** Layout strategy for placing targets. */
  layout?: 'piano-keys' | 'lanes';
  /** When true, print per-stage progress information. */
  verbose?: boolean;
}

/**
 * Layout configuration for the musical mapper (Stage C).
 */
export interface LayoutConfig {
  /** Layout strategy. */
  type: 'piano-keys' | 'lanes';
  /** Canvas width in pixels (> 0). */
  canvasWidth: number;
  /** Canvas height in pixels (> 0). */
  canvasHeight: number;
  /** Y-position of the target row. */
  targetY: number;
  /** MIDI pitch range to map, as `[minPitch, maxPitch]`. */
  pitchRange?: [number, number];
  /** Color scheme used to derive `colorHint` values. */
  colorScheme?: 'chromatic' | 'circle-of-fifths';

  // --- Optional note-filter fields (folded in from the design's `NoteFilter`) ---
  // These configure the musical mapper's density-thinning pass (Requirement
  // 3.5). They are optional and additive: when omitted, no filtering is applied,
  // so existing callers are unaffected.

  /**
   * Density threshold in notes-per-second. When a passage's density exceeds
   * this value, the mapper thins it by dropping lower-priority notes (preferring
   * higher velocity, then configured track priority) while preserving the
   * surviving notes' timing. When omitted, no density filtering is performed.
   */
  maxNotesPerSecond?: number;
  /**
   * Minimum normalized note velocity ([0.0, 1.0]) to retain. Reserved for
   * velocity-floor filtering; part of the folded-in `NoteFilter` contract.
   */
  minVelocity?: number;
  /**
   * Track names in descending priority order (e.g. melody before
   * accompaniment). Used as a secondary ranking during density thinning so
   * higher-priority tracks survive ties.
   */
  trackPriority?: string[];
}

/**
 * Configuration for the trajectory solver (Stage D).
 */
export interface SolverConfig {
  /** Gravitational acceleration in pixels/sec^2 (> 0). */
  gravity: number;
  /** Starting position of the object as `[x, y]`. */
  startPosition: [number, number];
  /** Energy retained on bounce, in [0, 1]. */
  bounceRestitution?: number;
  /** Style constraint: maximum arc apex height. */
  maxApexHeight?: number;
  /** Style preference: arc height-to-width ratio. */
  preferredArcRatio?: number;
  /** Acceptable timing error in milliseconds (default: 15). */
  syncToleranceMs?: number;
  /**
   * Keyframe sampling rate in frames/sec, controlling the density of the
   * intermediate keyframes the solver emits between impacts (default: 60).
   *
   * Optional and additive/backward-compatible: callers that omit it get the
   * default, so this does not affect existing usage. The solver samples each
   * arc into `ceil(duration * fps)` steps, so a higher value yields smoother
   * motion at the cost of more keyframes. Typically set to the pipeline's
   * render frame rate so keyframe density matches the output video's fps.
   */
  fps?: number;
}

/**
 * Configuration for the simulator/renderer (Stage E).
 */
export interface RenderConfig {
  /** Frame rate for interpolation/output. */
  fps: number;
  /** Frame width in pixels. */
  width: number;
  /** Frame height in pixels. */
  height: number;
  /** Background fill color (hex). */
  backgroundColor: string;
  /** Ball radius in pixels. */
  ballRadius: number;
  /** When true, draw a fading trail behind the ball. */
  showTrail?: boolean;
  /** When true, emit particle bursts on impact. */
  particlesOnImpact?: boolean;
  /** Directory to write frame PNGs into. */
  outputDir: string;
}

/**
 * Configuration for the video exporter (Stage F).
 */
export interface ExportConfig {
  /** Directory containing the frame PNGs. */
  frameDir: string;
  /** ffmpeg frame filename pattern (e.g. `'frame_%05d.png'`). */
  framePattern: string;
  /** Original audio file to mux into the output. */
  audioPath: string;
  /** Final output video path. */
  outputPath: string;
  /** Frame rate of the input frame sequence. */
  fps: number;
  /** Video codec (default: `'libx264'`). */
  codec?: string;
  /** H.264 CRF quality value (default: 18). */
  quality?: number;
}
