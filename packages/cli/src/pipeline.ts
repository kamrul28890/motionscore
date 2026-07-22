// End-to-end pipeline orchestration for the MotionScore CLI (task 9.2).
//
// `runPipeline` wires every stage of the pipeline together and runs them in
// sequence, validating the data contract at each boundary (Requirement 8):
//
//   input readable  (Req 1.2)
//     -> Stage B  extract notes            (extract)            -> validate  (Req 8.1)
//     -> Stage C  map to targets           (mapNotes)           -> validate  (Req 8.2)
//     -> Stage D  solve trajectory         (solveTrajectory)    -> validate  (Req 8.3)
//     -> ffmpeg fail-fast pre-flight       (before rendering; design Err #4)
//     -> Stage E  render frames            (render)
//     -> Stage F  export video             (exportVideo / exportVideoOnly)
//
// It returns a `PipelineResult` with the output path and summary statistics the
// CLI prints on success (Req 1.3). It never calls `process.exit`; errors are
// thrown for the caller (`main`) to format and translate into an exit code,
// which keeps the whole pipeline unit-testable (Req 1.2).
//
// Milestone scope: both MIDI (M1) and audio (M2) inputs are supported. Stage B
// delegates to the note-extractor's `extract`, which routes by extension — MIDI
// is parsed directly and audio is transcribed to MIDI via Basic Pitch and then
// parsed through the same path (task 11.2). Because a MIDI file carries no
// decodable audio track, the MIDI path exports a video-only MP4 (see
// `video-only.ts`); the audio path muxes the ORIGINAL audio file into the output
// via Stage F's audio-muxing `exportVideo`.

import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateNoteEvents,
  validateChoreographyTargets,
  validateObjectTrajectory,
  type NoteEvent,
  type ChoreographyTarget,
  type ObjectTrajectory,
  type LayoutConfig,
  type SolverConfig,
  type RenderConfig,
  type ExportConfig,
} from '@motionscore/types';
import { extract } from '@motionscore/note-extractor';
import { mapNotes } from '@motionscore/musical-mapper';
import { solveTrajectory } from '@motionscore/trajectory-solver';
import { render } from '@motionscore/renderer';
import { exportVideo, type ExportProgressCallback } from '@motionscore/video-export';

import { assertInputReadable, type ParsedArgs } from './args.js';
import { assertFfmpegAvailable, exportVideoOnly } from './video-only.js';

/**
 * The result of a successful pipeline run: the written output path plus the
 * summary statistics the CLI reports (Req 1.3, design `PipelineResult`).
 */
export interface PipelineResult {
  /** Path of the written output video (equals the requested `--output`). */
  outputPath: string;
  /** Summary statistics printed on success. */
  stats: {
    /** Number of notes extracted from the input (Stage B). */
    totalNotes: number;
    /** Number of PNG frames rendered and muxed (Stage E). */
    renderedFrames: number;
    /** Content duration in seconds (last keyframe / note release). */
    durationSec: number;
    /** Worst-case impact timing error across all hits, in milliseconds. */
    maxSyncErrorMs: number;
  };
}

// --- Pipeline-wide defaults ------------------------------------------------
// `parseArgs` always fills these, but `CLIOptions` types them optional and
// `runPipeline` is callable directly (e.g. in tests), so fall back defensively.

const DEFAULT_FPS = 60;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_LAYOUT: 'piano-keys' | 'lanes' = 'piano-keys';

/** MIDI pitch range mapped across the canvas width (88-key piano: A0..C8). */
const PITCH_RANGE: [number, number] = [21, 108];

/** Color scheme handed to the mapper (design "Example Usage"). */
const COLOR_SCHEME = 'circle-of-fifths';

/** Scene background fill (design "Example Usage"). */
const BACKGROUND_COLOR = '#1a1a2e';

/** ffmpeg frame filename pattern; matches the renderer's 1-based zero-padded names. */
const FRAME_PATTERN = 'frame_%05d.png';

/** Sync tolerance (ms) for the solver and the Stage D validation (Req 4.2 / 8.3). */
const SYNC_TOLERANCE_MS = 15;

// The following ratios are expressed relative to the design's 1080p reference so
// the scene scales sensibly at other resolutions while reproducing the design's
// "Example Usage" values exactly at 1920x1080 (targetY 900, gravity 980,
// start [960, 100], ballRadius 12).

/** Target row y-position as a fraction of canvas height (900/1080). */
const TARGET_Y_RATIO = 900 / 1080;
/** Object launch y-position as a fraction of canvas height (100/1080). */
const START_Y_RATIO = 100 / 1080;
/** Gravity (px/s^2) as a fraction of canvas height (980/1080). */
const GRAVITY_PER_HEIGHT = 980 / 1080;
/** Ball radius (px) as a fraction of canvas height (12/1080), floored so it stays visible. */
const BALL_RADIUS_PER_HEIGHT = 12 / 1080;
/** Minimum ball radius in pixels (the renderer requires a positive radius). */
const MIN_BALL_RADIUS = 4;

/** Emit a verbose progress line to stderr (kept off stdout so stats stay clean). */
function logVerbose(verbose: boolean, message: string): void {
  if (verbose) {
    process.stderr.write(`[motionscore] ${message}\n`);
  }
}

/** Announce the start of a stage in verbose mode. */
function stageStart(verbose: boolean, name: string): number {
  logVerbose(verbose, `${name}...`);
  return performance.now();
}

/** Report a stage's elapsed time (and optional detail) in verbose mode. */
function stageDone(verbose: boolean, name: string, startedAt: number, detail?: string): void {
  if (!verbose) {
    return;
  }
  const elapsedMs = (performance.now() - startedAt).toFixed(1);
  logVerbose(verbose, `${name} done in ${elapsedMs}ms${detail === undefined ? '' : ` (${detail})`}`);
}

/**
 * Compute the worst-case impact timing error, in milliseconds, between each
 * impact keyframe (`hitsTarget` set) and the target it references. This is the
 * observed end-to-end sync accuracy reported in the stats (Req 1.3); the
 * solver already guarantees it is within {@link SYNC_TOLERANCE_MS} (Req 4.2).
 */
function computeMaxSyncErrorMs(
  trajectory: ObjectTrajectory,
  targets: readonly ChoreographyTarget[],
): number {
  const targetTimeById = new Map<string, number>();
  for (const target of targets) {
    targetTimeById.set(target.noteId, target.timeSec);
  }
  let maxErrorMs = 0;
  for (const keyframe of trajectory.keyframes) {
    if (keyframe.hitsTarget === undefined) {
      continue;
    }
    const targetTime = targetTimeById.get(keyframe.hitsTarget);
    if (targetTime === undefined) {
      continue;
    }
    maxErrorMs = Math.max(maxErrorMs, Math.abs(keyframe.tSec - targetTime) * 1000);
  }
  return maxErrorMs;
}

/** Content duration: the later of the last keyframe time and the last note release. */
function computeDurationSec(
  trajectory: ObjectTrajectory,
  notes: readonly NoteEvent[],
): number {
  const lastKeyframe = trajectory.keyframes[trajectory.keyframes.length - 1];
  const lastKeyframeTSec = lastKeyframe?.tSec ?? 0;
  let lastNoteEndSec = 0;
  for (const note of notes) {
    if (note.endSec > lastNoteEndSec) {
      lastNoteEndSec = note.endSec;
    }
  }
  return Math.max(lastKeyframeTSec, lastNoteEndSec);
}

/**
 * Run the complete MotionScore pipeline for a parsed CLI invocation.
 *
 * Stages run sequentially with a data-contract validation at every boundary
 * (Req 8.1-8.4). Progress and per-stage timings are printed to stderr when
 * `options.verbose` is set (Req 1.5); the success summary is left for the caller
 * to print from the returned {@link PipelineResult} (Req 1.3).
 *
 * MIDI input is parsed directly; audio input is transcribed to MIDI (Basic
 * Pitch) and parsed through the same path — both handled by the note-extractor's
 * `extract` in Stage B (task 11.2).
 *
 * The rendered frames are written to a fresh temporary directory that is always
 * removed before returning (success or failure), so a run never leaves thousands
 * of PNGs behind.
 *
 * @param parsed Normalized options plus the detected input type (from `parseArgs`).
 * @returns The output path and summary statistics on success.
 * @throws {InputError} if the input is missing/unreadable or has an unsupported
 *   extension.
 * @throws {TranscriptionError} if audio transcription (Basic Pitch) fails.
 * @throws {ValidationError} if any stage boundary's data contract is violated.
 * @throws {ExportError} if ffmpeg is unavailable or the encode fails.
 * @throws {Error} if rendering produces no frames to export.
 */
export async function runPipeline(parsed: ParsedArgs): Promise<PipelineResult> {
  const { options, inputType } = parsed;
  const verbose = options.verbose === true;

  const fps = options.fps ?? DEFAULT_FPS;
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const layout = options.layout ?? DEFAULT_LAYOUT;

  // Resolution-scaled scene parameters (see ratio constants above).
  const targetY = Math.round(height * TARGET_Y_RATIO);
  const gravity = Math.round(height * GRAVITY_PER_HEIGHT);
  const startPosition: [number, number] = [width / 2, Math.round(height * START_Y_RATIO)];
  const ballRadius = Math.max(MIN_BALL_RADIUS, Math.round(height * BALL_RADIUS_PER_HEIGHT));

  // Only audio-format inputs carry an audio track to mux; MIDI has none (no
  // synthesis), so it exports video-only. Computed up front so the export branch
  // below reads declaratively. For audio input this is the ORIGINAL audio file,
  // which Stage F muxes alongside the rendered video (Req 6.1).
  const audioPath = inputType === 'audio' ? options.input : undefined;

  let framesDir: string | undefined;
  try {
    // --- Input readable (Req 1.2) -----------------------------------------
    let startedAt = stageStart(verbose, 'check input readable');
    await assertInputReadable(options.input);
    stageDone(verbose, 'check input readable', startedAt, options.input);

    // --- Stage B: extract notes -------------------------------------------
    // `extract` routes by file extension: MIDI is parsed directly; audio is
    // transcribed to MIDI via Basic Pitch and then parsed through the same path
    // (Req 7.1, 7.2). For audio input this stage's timing includes
    // transcription, which can dominate the overall run.
    startedAt = stageStart(verbose, 'extract notes (Stage B)');
    const notes: NoteEvent[] = await extract(options.input);
    stageDone(verbose, 'extract notes (Stage B)', startedAt, `${notes.length} notes`);

    // Stage B -> C boundary validation (Req 8.1).
    validateNoteEvents(notes);
    logVerbose(verbose, `validated ${notes.length} note events (Stage B->C boundary)`);

    // --- Stage C: map notes to choreography targets -----------------------
    startedAt = stageStart(verbose, 'map notes (Stage C)');
    const layoutConfig: LayoutConfig = {
      type: layout,
      canvasWidth: width,
      canvasHeight: height,
      targetY,
      pitchRange: PITCH_RANGE,
      colorScheme: COLOR_SCHEME,
    };
    const targets: ChoreographyTarget[] = mapNotes(notes, layoutConfig);
    stageDone(verbose, 'map notes (Stage C)', startedAt, `${targets.length} targets`);

    // Stage C -> D boundary validation (Req 8.2). Passing the source notes also
    // verifies every noteId resolves and each timeSec matches its note.
    validateChoreographyTargets(targets, width, height, notes);
    logVerbose(verbose, `validated ${targets.length} targets (Stage C->D boundary)`);

    // --- Stage D: solve trajectory ----------------------------------------
    startedAt = stageStart(verbose, 'solve trajectory (Stage D)');
    const solverConfig: SolverConfig = {
      gravity,
      startPosition,
      fps,
      syncToleranceMs: SYNC_TOLERANCE_MS,
    };
    const trajectory: ObjectTrajectory = solveTrajectory(targets, solverConfig);
    const impactCount = trajectory.keyframes.filter((kf) => kf.hitsTarget !== undefined).length;
    stageDone(
      verbose,
      'solve trajectory (Stage D)',
      startedAt,
      `${trajectory.keyframes.length} keyframes, ${impactCount} impacts`,
    );

    // Stage D -> E boundary validation (Req 8.3).
    validateObjectTrajectory(trajectory, targets, SYNC_TOLERANCE_MS);
    logVerbose(verbose, `validated trajectory (Stage D->E boundary)`);

    // --- ffmpeg pre-flight (fail fast before rendering; design Error #4) ---
    startedAt = stageStart(verbose, 'check ffmpeg available');
    await assertFfmpegAvailable();
    stageDone(verbose, 'check ffmpeg available', startedAt);

    // --- Stage E: render frames -------------------------------------------
    framesDir = await mkdtemp(join(tmpdir(), 'motionscore-frames-'));
    logVerbose(verbose, `rendering frames into ${framesDir}`);
    startedAt = stageStart(verbose, 'render frames (Stage E)');
    const renderConfig: RenderConfig = {
      fps,
      width,
      height,
      backgroundColor: BACKGROUND_COLOR,
      ballRadius,
      showTrail: true,
      particlesOnImpact: true,
      outputDir: framesDir,
    };
    const framePaths = await render(trajectory, targets, renderConfig);
    stageDone(verbose, 'render frames (Stage E)', startedAt, `${framePaths.length} frames`);

    if (framePaths.length === 0) {
      // Only happens when the trajectory has no keyframes (e.g. every target was
      // unreachable and skipped). There is nothing to encode.
      throw new Error(
        'Rendering produced no frames to export (the solved trajectory has no keyframes).',
      );
    }

    // --- Stage F: export video --------------------------------------------
    const onProgress: ExportProgressCallback | undefined = verbose
      ? (progress) => {
          if (progress.frames !== undefined) {
            logVerbose(verbose, `export progress: ${progress.frames} frames encoded`);
          }
        }
      : undefined;

    startedAt = stageStart(verbose, 'export video (Stage F)');
    let outputPath: string;
    if (audioPath !== undefined) {
      // Audio input (M2): mux the original audio alongside the video.
      const exportConfig: ExportConfig = {
        frameDir: framesDir,
        framePattern: FRAME_PATTERN,
        audioPath,
        outputPath: options.output,
        fps,
      };
      outputPath = await exportVideo(exportConfig, onProgress);
    } else {
      // MIDI input (M1): no audio track to mux -> video-only MP4.
      outputPath = await exportVideoOnly(
        {
          frameDir: framesDir,
          framePattern: FRAME_PATTERN,
          outputPath: options.output,
          fps,
        },
        onProgress,
      );
    }
    stageDone(verbose, 'export video (Stage F)', startedAt, outputPath);

    return {
      outputPath,
      stats: {
        totalNotes: notes.length,
        renderedFrames: framePaths.length,
        durationSec: computeDurationSec(trajectory, notes),
        maxSyncErrorMs: computeMaxSyncErrorMs(trajectory, targets),
      },
    };
  } finally {
    // Always remove the temporary frames, on success or failure, so a run never
    // leaves thousands of PNGs behind. `force` swallows ENOENT if it was never
    // created; the extra catch guards against any other cleanup error so it
    // cannot mask the pipeline's own outcome.
    if (framesDir !== undefined) {
      await rm(framesDir, { recursive: true, force: true }).catch(() => {});
      logVerbose(verbose, `removed temporary frame directory ${framesDir}`);
    }
  }
}
