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

import {
  validateNoteEvents,
  validateChoreographyTargets,
  validateChoreography,
  ROLE_ACTIVITY_BINS,
  ROLE_ORDER,
  type AudioAnalysis,
  type AudioAnalysisSummary,
  type AudioEnergySample,
  type Choreography,
  type HitRole,
  type NoteEvent,
  type ChoreographyTarget,
  type ObjectTrajectory,
  type LayoutConfig,
  type SolverConfig,
  type RenderConfig,
  type VoiceGrouping,
} from '@motionscore/types';
import { extractWithAnalysis } from '@motionscore/note-extractor';
import { mapNotes, planVoices } from '@motionscore/musical-mapper';
import { solveChoreography } from '@motionscore/trajectory-solver';
import { render, renderAndEncodeVoices, type RenderVoice } from '@motionscore/renderer';
import {
  exportVideo,
  detectAvailableEncoders,
  type ExportProgressCallback,
} from '@motionscore/video-export';

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
  /**
   * Compact smart-analysis summary, present only for audio input analyzed with
   * a rhythmic mode (`auto`/`smart`, `beats`, `onsets`). Absent for MIDI and
   * `notes` transcription.
   */
  analysis?: AudioAnalysisSummary;
}

/** Cap on the downsampled energy timeline points carried in the summary. */
const MAX_ENERGY_SAMPLES = 160;

/** Project a full {@link AudioAnalysis} into the compact UI-facing summary. */
function summarizeAnalysis(analysis: AudioAnalysis): AudioAnalysisSummary {
  const roleCounts: Record<HitRole, number> = {
    kick: 0,
    bass: 0,
    snare: 0,
    percussion: 0,
    melodic: 0,
    vocal: 0,
    piano: 0,
    guitar: 0,
  };
  const roleActivity: Record<HitRole, number[]> = {
    kick: new Array<number>(ROLE_ACTIVITY_BINS).fill(0),
    bass: new Array<number>(ROLE_ACTIVITY_BINS).fill(0),
    snare: new Array<number>(ROLE_ACTIVITY_BINS).fill(0),
    percussion: new Array<number>(ROLE_ACTIVITY_BINS).fill(0),
    melodic: new Array<number>(ROLE_ACTIVITY_BINS).fill(0),
    vocal: new Array<number>(ROLE_ACTIVITY_BINS).fill(0),
    piano: new Array<number>(ROLE_ACTIVITY_BINS).fill(0),
    guitar: new Array<number>(ROLE_ACTIVITY_BINS).fill(0),
  };

  // Bin each roled hit by its onset time, accumulating velocity, so the UI can
  // show when each instrument is active over the song.
  const durationSec = analysis.durationSec > 0 ? analysis.durationSec : 0;
  for (const hit of analysis.hits) {
    if (hit.role === undefined) {
      continue;
    }
    roleCounts[hit.role] += 1;
    const frac = durationSec > 0 ? hit.startSec / durationSec : 0;
    const bin = Math.max(
      0,
      Math.min(ROLE_ACTIVITY_BINS - 1, Math.floor(frac * ROLE_ACTIVITY_BINS)),
    );
    roleActivity[hit.role]![bin]! += hit.velocity > 0 ? hit.velocity : 1;
  }

  // Normalize each role against its own peak bin: the strip reveals an
  // instrument's temporal pattern independent of absolute loudness.
  for (const role of ROLE_ORDER) {
    const bins = roleActivity[role]!;
    let max = 0;
    for (const value of bins) {
      if (value > max) max = value;
    }
    if (max > 0) {
      for (let i = 0; i < bins.length; i += 1) {
        bins[i] = Math.round((bins[i]! / max) * 1000) / 1000;
      }
    }
  }

  return {
    mode: analysis.mode,
    tempoBpm: analysis.tempoBpm,
    durationSec: analysis.durationSec,
    hitCount: analysis.hits.length,
    roleCounts,
    roleActivity,
    sectionCues: analysis.sectionCues,
    energyTimeline: downsampleEnergy(analysis.featureFrames, MAX_ENERGY_SAMPLES),
  };
}

/**
 * Reduce 10 Hz feature frames to at most `maxSamples` averaged points so the
 * timeline stays compact when serialized. Each point keeps the bucket's mean
 * loudness/bass energy and a representative timestamp.
 */
function downsampleEnergy(
  frames: readonly { timeSec: number; loudness: number; bassEnergy: number }[],
  maxSamples: number,
): AudioEnergySample[] {
  if (frames.length === 0) {
    return [];
  }
  if (frames.length <= maxSamples) {
    return frames.map((frame) => ({
      timeSec: frame.timeSec,
      loudness: frame.loudness,
      bassEnergy: frame.bassEnergy,
    }));
  }

  const bucketSize = frames.length / maxSamples;
  const samples: AudioEnergySample[] = [];
  for (let i = 0; i < maxSamples; i += 1) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(frames.length, Math.floor((i + 1) * bucketSize));
    let loudness = 0;
    let bassEnergy = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      const frame = frames[j]!;
      loudness += frame.loudness;
      bassEnergy += frame.bassEnergy;
      count += 1;
    }
    if (count === 0) {
      continue;
    }
    const midFrame = frames[Math.min(frames.length - 1, Math.floor((start + end) / 2))]!;
    samples.push({
      timeSec: midFrame.timeSec,
      loudness: loudness / count,
      bassEnergy: bassEnergy / count,
    });
  }
  return samples;
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

/** Hardware H.264 encoders, in the order we prefer them when auto-selecting. */
const GPU_ENCODER_PREFERENCE = ['h264_nvenc', 'h264_amf', 'h264_qsv'] as const;

/**
 * Resolve which H.264 encoder to use for the render+encode stage.
 *
 * An explicit `--codec` always wins (the user asked for it). Otherwise we probe
 * which encoders actually run in the installed ffmpeg — `detectAvailableEncoders`
 * does a real one-frame test-encode per candidate, so a codec that is compiled
 * in but non-functional (e.g. NVENC with no NVIDIA GPU) is not offered — and
 * prefer a hardware encoder, which is dramatically faster than libx264 for this
 * workload. Falls back to libx264, which is always present when ffmpeg is.
 */
async function resolveCodec(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const available = new Set(await detectAvailableEncoders());
  for (const codec of GPU_ENCODER_PREFERENCE) {
    if (available.has(codec)) {
      return codec;
    }
  }
  return 'libx264';
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

/** Keep rendering through the source tail after the final selected hit. */
function extendTrajectoryToDuration(
  trajectory: ObjectTrajectory,
  durationSec: number,
): ObjectTrajectory {
  const last = trajectory.keyframes[trajectory.keyframes.length - 1];
  if (last === undefined || !Number.isFinite(durationSec) || durationSec <= last.tSec) {
    return trajectory;
  }
  return {
    objectId: trajectory.objectId,
    keyframes: [
      ...trajectory.keyframes,
      {
        tSec: durationSec,
        pos: [last.pos[0], last.pos[1]],
        vel: [0, 0],
      },
    ],
  };
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

  // --- Input readable (Req 1.2) -----------------------------------------
  let startedAt = stageStart(verbose, 'check input readable');
  await assertInputReadable(options.input);
  stageDone(verbose, 'check input readable', startedAt, options.input);

    // --- Stage B: extract notes -------------------------------------------
    // `extractWithAnalysis` routes MIDI directly, mixed audio through the
    // smart/beats/onsets analyzer, and explicit notes mode through Basic Pitch.
    // Rich analysis retains source duration so rendering can hold through the
    // complete audio tail.
    startedAt = stageStart(verbose, 'extract notes (Stage B)');
    const extraction = await extractWithAnalysis(options.input, { mode: options.mode });
    const notes: NoteEvent[] = extraction.notes;
    const analyzedDurationSec = extraction.audioAnalysis?.durationSec;
    // Report the RESOLVED mode (e.g. auto -> smart, or stems) so it is obvious
    // which analyzer ran — only `stems` uses the GPU.
    const analyzedMode = extraction.audioAnalysis?.mode;
    stageDone(
      verbose,
      'extract notes (Stage B)',
      startedAt,
      analyzedMode ? `${analyzedMode} mode, ${notes.length} notes` : `${notes.length} notes`,
    );

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

    // --- Stage D: plan voices + solve per-ball trajectories ---------------
    // Targets are partitioned into one or more balls (`planVoices`), and each
    // ball is solved independently (`solveChoreography`). `balls: 'single'`
    // (default) yields one ball over all targets — identical to the legacy
    // behavior. See docs/MULTI_BALL_PLAN.md.
    startedAt = stageStart(verbose, 'solve trajectory (Stage D)');
    const solverConfig: SolverConfig = {
      gravity,
      startPosition,
      fps,
      syncToleranceMs: SYNC_TOLERANCE_MS,
    };
    const grouping: VoiceGrouping = options.balls ?? 'single';
    const voicePlans = planVoices(targets, grouping, layoutConfig);
    const solved = solveChoreography(voicePlans, solverConfig);

    // Hold every ball through the full source duration so the video does not end
    // on the last hit while audio continues.
    const solvedDurationSec = solved.voices.reduce(
      (max, voice) => Math.max(max, computeDurationSec(voice.trajectory, notes)),
      0,
    );
    const requestedDurationSec = Math.max(analyzedDurationSec ?? 0, solvedDurationSec);
    const choreography: Choreography = {
      durationSec: requestedDurationSec,
      voices: solved.voices.map((voice) => ({
        ...voice,
        trajectory: extendTrajectoryToDuration(voice.trajectory, requestedDurationSec),
      })),
    };

    const impactCount = choreography.voices.reduce(
      (sum, voice) =>
        sum + voice.trajectory.keyframes.filter((kf) => kf.hitsTarget !== undefined).length,
      0,
    );
    stageDone(
      verbose,
      'solve trajectory (Stage D)',
      startedAt,
      `${choreography.voices.length} voice(s), ${impactCount} impacts`,
    );

    // Stage D -> E boundary validation (Req 8.3), per voice.
    validateChoreography(choreography, width, height, SYNC_TOLERANCE_MS, notes);
    logVerbose(
      verbose,
      `validated ${choreography.voices.length} voice(s) (Stage D->E boundary)`,
    );

    const maxSyncErrorMs = choreography.voices.reduce(
      (max, voice) => Math.max(max, computeMaxSyncErrorMs(voice.trajectory, voice.targets)),
      0,
    );

    // --- ffmpeg pre-flight (fail fast before rendering; design Error #4) ---
    startedAt = stageStart(verbose, 'check ffmpeg available');
    await assertFfmpegAvailable();
    stageDone(verbose, 'check ffmpeg available', startedAt);

    // Pick the encoder before rendering: honor an explicit --codec, else probe
    // for a working GPU encoder (much faster than libx264 for this workload).
    startedAt = stageStart(verbose, 'select encoder');
    const codec = await resolveCodec(options.codec);
    stageDone(
      verbose,
      'select encoder',
      startedAt,
      options.codec ? `${codec} (explicit)` : `${codec} (auto-selected)`,
    );

    // --- Stage E + F: render and encode (streaming) -------------------------
    // Uses the high-performance streaming path: draws each frame and pipes raw
    // RGBA pixels directly to ffmpeg's stdin, skipping PNG encoding and disk I/O.
    // This is 3-5x faster than the file-based render→encode path for large
    // frame counts.
    startedAt = stageStart(verbose, 'render + encode (Stage E+F)');
    const renderConfig: RenderConfig = {
      fps,
      width,
      height,
      backgroundColor: BACKGROUND_COLOR,
      ballRadius,
      showTrail: true,
      particlesOnImpact: true,
      outputDir: '', // unused in streaming path
      parallelFrames: options.parallelFrames ?? (await import('node:os')).availableParallelism(),
    };

    const renderVoices: RenderVoice[] = choreography.voices.map((voice) => ({
      trajectory: voice.trajectory,
      targets: voice.targets,
      ballColor: voice.colorHint,
    }));

    const streamResult = await renderAndEncodeVoices(
      renderVoices,
      renderConfig,
      {
        outputPath: options.output,
        fps,
        codec,
        gpuDevice: options.gpuDevice,
        preset: options.preset,
        quality: undefined,
        audioPath,
      },
      verbose
        ? (rendered, total) => {
            logVerbose(verbose, `render+encode progress: ${rendered}/${total} frames`);
          }
        : undefined,
    );
    stageDone(verbose, 'render + encode (Stage E+F)', startedAt,
      `${streamResult.renderedFrames} frames → ${streamResult.outputPath}`);

    const result: PipelineResult = {
      outputPath: streamResult.outputPath,
      stats: {
        totalNotes: notes.length,
        renderedFrames: streamResult.renderedFrames,
        durationSec: requestedDurationSec,
        maxSyncErrorMs,
      },
    };
    if (extraction.audioAnalysis !== undefined) {
      result.analysis = summarizeAnalysis(extraction.audioAnalysis);
    }
    return result;
}
