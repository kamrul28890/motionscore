// Stream renderer for MotionScore Stage E (high-performance path).
//
// Instead of rendering individual PNG files to disk (the `render()` path),
// `renderToStream` draws each frame and pipes the raw RGBA pixel buffer directly
// to the provided writable stream (typically ffmpeg's stdin in rawvideo mode).
// This eliminates:
//   - PNG compression per frame (the single biggest cost in the file-based path)
//   - Disk I/O for thousands of frame files
//   - ffmpeg's PNG decompression step when reading them back
//
// The result is dramatically faster for long videos. For a 4500-frame 1080p@60
// render, this path is typically 3-5x faster than the PNG-to-disk path.
//
// The caller is responsible for setting up the ffmpeg process with rawvideo input
// (see `renderAndEncode` in this module for the integrated pipeline).

import { spawn, type ChildProcess } from 'node:child_process';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';
import type {
  ChoreographyTarget,
  ObjectTrajectory,
  RenderConfig,
  ExportConfig,
} from '@motionscore/types';
import { ExportError } from '@motionscore/types';

import { interpolatePosition } from './interpolate.js';
import { RenderError, exceedsFailureBudget } from './render.js';

/** Ball fill color. */
const BALL_COLOR = '#f5f5fa';
/** Trail color. */
const TRAIL_COLOR = '#f5f5fa';
const TRAIL_SECONDS = 0.25;
const PARTICLE_DURATION_SEC = 0.35;
const PARTICLE_RING_COUNT = 3;
const PARTICLE_RING_STAGGER = 0.14;
const KEY_WIDTH_FACTOR = 2.5;
const KEY_HEIGHT_FACTOR = 6;
const FRAME_FAILURE_BUDGET = 0.05;

interface ImpactEvent {
  timeSec: number;
  x: number;
  y: number;
  color: string;
  impactSize: number;
}

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value < 1 ? value : 1;
}

/** A single ball to render: its motion, the targets it strikes, and its tint. */
export interface RenderVoice {
  /** The solved motion for this ball. */
  trajectory: ObjectTrajectory;
  /** The targets (keys) associated with this ball. */
  targets: ChoreographyTarget[];
  /** Ball fill color; defaults to the shared white ball color. */
  ballColor?: string;
}

/**
 * Backward-compatible single-ball entry point (Stage E + F streaming). Delegates
 * to {@link renderAndEncodeVoices} with one white ball.
 *
 * @returns The output file path and number of frames rendered.
 */
export async function renderAndEncode(
  trajectory: ObjectTrajectory,
  targets: ChoreographyTarget[],
  renderConfig: RenderConfig,
  exportConfig: Pick<ExportConfig, 'outputPath' | 'fps' | 'codec' | 'gpuDevice' | 'preset' | 'quality'> & { audioPath?: string },
  onProgress?: (rendered: number, total: number) => void,
): Promise<{ outputPath: string; renderedFrames: number }> {
  return renderAndEncodeVoices(
    [{ trajectory, targets, ballColor: BALL_COLOR }],
    renderConfig,
    exportConfig,
    onProgress,
  );
}

/**
 * Render one or more balls (voices) and encode directly to an MP4 via ffmpeg in
 * a single streaming pass. No intermediate PNG files are written to disk.
 *
 * Every voice's targets are drawn as keys and every voice's impacts are shown;
 * each voice gets its own tinted ball and trail. The frame count spans the
 * longest voice, so shorter balls rest at their final position for the rest of
 * the video.
 *
 * @returns The output file path and number of frames rendered.
 */
export async function renderAndEncodeVoices(
  voices: readonly RenderVoice[],
  renderConfig: RenderConfig,
  exportConfig: Pick<ExportConfig, 'outputPath' | 'fps' | 'codec' | 'gpuDevice' | 'preset' | 'quality'> & { audioPath?: string },
  onProgress?: (rendered: number, total: number) => void,
): Promise<{ outputPath: string; renderedFrames: number }> {
  const { fps, width, height, backgroundColor, ballRadius } = renderConfig;

  const activeVoices = voices.filter((v) => v.trajectory.keyframes.length > 0);
  if (activeVoices.length === 0) {
    throw new RenderError('Cannot render: no voice has any keyframes.');
  }

  const maxTSec = activeVoices.reduce((max, v) => {
    const kf = v.trajectory.keyframes;
    return Math.max(max, kf[kf.length - 1]!.tSec);
  }, 0);
  const totalFrames = Math.max(1, Math.ceil(maxTSec * fps) + 1);

  // Every voice's targets are drawn as keys.
  const allTargets: ChoreographyTarget[] = [];
  for (const v of voices) {
    for (const target of v.targets) allTargets.push(target);
  }

  // Precompute impacts across all voices.
  const impacts: ImpactEvent[] = [];
  for (const v of voices) {
    const targetsById = new Map<string, ChoreographyTarget>();
    for (const target of v.targets) targetsById.set(target.noteId, target);
    for (const kf of v.trajectory.keyframes) {
      if (kf.hitsTarget === undefined) continue;
      const target = targetsById.get(kf.hitsTarget);
      impacts.push({
        timeSec: kf.tSec,
        x: target ? target.position.x : kf.pos[0],
        y: target ? target.position.y : kf.pos[1],
        color: target ? target.colorHint : (v.ballColor ?? BALL_COLOR),
        impactSize: target ? clamp01(target.impactSize) : 0.5,
      });
    }
  }

  const drawTrail = renderConfig.showTrail === true;
  const drawParticles = renderConfig.particlesOnImpact !== false;
  const trailLength = Math.max(2, Math.round(fps * TRAIL_SECONDS));

  // Precompute per-voice frame positions; each voice keeps its own trail buffer.
  const prepared = activeVoices.map((v) => {
    const positions: Array<[number, number]> = [];
    for (let i = 0; i < totalFrames; i++) {
      positions.push(interpolatePosition(v.trajectory.keyframes, i / fps));
    }
    return {
      positions,
      color: v.ballColor ?? BALL_COLOR,
      trail: [] as Array<[number, number]>,
    };
  });

  // Build ffmpeg command for rawvideo input
  const ffmpegBin = process.env.FFMPEG_PATH ?? 'ffmpeg';
  const codec = exportConfig.codec ?? 'libx264';
  const quality = exportConfig.quality ?? 18;

  const inputArgs = [
    '-y', '-hide_banner', '-loglevel', 'error',
    // Raw video input from stdin
    '-f', 'rawvideo',
    '-pixel_format', 'rgba',
    '-video_size', `${width}x${height}`,
    '-framerate', String(fps),
    '-i', 'pipe:0',
  ];

  // Add audio input if provided
  if (exportConfig.audioPath) {
    inputArgs.push('-i', exportConfig.audioPath);
  }

  // Encoder-specific output options
  const outputArgs: string[] = ['-c:v', codec];

  if (codec === 'h264_nvenc') {
    outputArgs.push('-rc', 'constqp', '-cq', String(quality));
    outputArgs.push('-preset', exportConfig.preset ?? 'p4');
    if (exportConfig.gpuDevice !== undefined) outputArgs.push('-gpu', String(exportConfig.gpuDevice));
  } else if (codec === 'h264_amf') {
    outputArgs.push('-rc', 'cqp', '-qp_i', String(quality), '-qp_p', String(quality));
    outputArgs.push('-quality', exportConfig.preset ?? 'balanced');
  } else if (codec === 'h264_qsv') {
    outputArgs.push('-global_quality', String(quality));
  } else {
    // libx264
    outputArgs.push('-crf', String(quality));
    if (exportConfig.preset) outputArgs.push('-preset', exportConfig.preset);
  }

  outputArgs.push('-pix_fmt', 'yuv420p');

  if (exportConfig.audioPath) {
    outputArgs.push('-c:a', 'aac', '-map', '0:v:0', '-map', '1:a:0');
  }

  outputArgs.push(exportConfig.outputPath);

  const ffmpegArgs = [...inputArgs, ...outputArgs];

  // Spawn ffmpeg
  const ffmpeg = spawn(ffmpegBin, ffmpegArgs, { shell: false, stdio: ['pipe', 'ignore', 'pipe'] });

  let ffmpegError = '';
  ffmpeg.stderr!.on('data', (chunk: Buffer) => { ffmpegError += chunk.toString(); });

  const ffmpegDone = new Promise<void>((resolve, reject) => {
    ffmpeg.on('error', (err) => reject(new ExportError(`ffmpeg spawn failed: ${err.message}`, { cause: err })));
    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new ExportError(`ffmpeg exited with code ${code}: ${ffmpegError.slice(0, 500)}`));
    });
  });

  // ffmpeg can exit early on an invalid config (e.g. odd width/height, which
  // yuv420p rejects). Swallow stdin pipe errors so the real reason surfaces as
  // the ExportError from the 'close' handler above, instead of crashing the
  // process with an unhandled 'error' event.
  ffmpeg.stdin!.on('error', () => {});

  // Render frames and stream to ffmpeg
  const canvas = createCanvas(width, height) as Canvas;
  const ctx = canvas.getContext('2d');

  try {
    for (let i = 0; i < totalFrames; i++) {
      // If ffmpeg exited early (e.g. invalid config), stop writing so its
      // failure surfaces cleanly via `await ffmpegDone` below rather than
      // throwing a write-after-end error that skips it.
      if (!ffmpeg.stdin!.writable) break;

      const t = i / fps;

      // Draw frame
      ctx.globalAlpha = 1;
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);
      drawTargets(ctx, allTargets, ballRadius);

      // Trails under everything, then impacts, then the balls on top.
      if (drawTrail) {
        for (const pv of prepared) {
          pv.trail.push(pv.positions[i]!);
          if (pv.trail.length > trailLength) pv.trail.shift();
          if (pv.trail.length >= 2) drawTrailLine(ctx, pv.trail, ballRadius, pv.color);
        }
      }
      if (drawParticles) drawImpacts(ctx, impacts, t, ballRadius);
      for (const pv of prepared) {
        drawBall(ctx, pv.positions[i]!, ballRadius, pv.color);
      }

      // Get raw RGBA pixels and write to ffmpeg stdin
      const imageData = ctx.getImageData(0, 0, width, height);
      const buffer = Buffer.from(imageData.data.buffer);

      const canWrite = ffmpeg.stdin!.write(buffer);
      if (!canWrite) {
        // Backpressure: wait for drain, but also unblock if ffmpeg closed the
        // pipe early so a failed encode surfaces via ffmpegDone instead of
        // hanging. All three listeners are removed once any fires so they do
        // not accumulate across the many backpressure waits in a long render.
        const stdin = ffmpeg.stdin!;
        await new Promise<void>((resolve) => {
          const settle = (): void => {
            stdin.removeListener('drain', settle);
            stdin.removeListener('close', settle);
            stdin.removeListener('error', settle);
            resolve();
          };
          stdin.once('drain', settle);
          stdin.once('close', settle);
          stdin.once('error', settle);
        });
      }

      if (onProgress && i % 50 === 0) {
        onProgress(i, totalFrames);
      }
    }
  } finally {
    ffmpeg.stdin!.end();
  }

  if (onProgress) onProgress(totalFrames, totalFrames);

  await ffmpegDone;
  return { outputPath: exportConfig.outputPath, renderedFrames: totalFrames };
}

// --- Drawing helpers (same as render.ts but inlined to avoid circular deps) ---

function drawTargets(ctx: SKRSContext2D, targets: readonly ChoreographyTarget[], ballRadius: number): void {
  const keyWidth = Math.max(4, ballRadius * KEY_WIDTH_FACTOR);
  const fullHeight = Math.max(8, ballRadius * KEY_HEIGHT_FACTOR);
  ctx.globalAlpha = 1;
  for (const target of targets) {
    const keyHeight = fullHeight * (0.5 + 0.5 * clamp01(target.impactSize));
    ctx.fillStyle = target.colorHint;
    ctx.fillRect(target.position.x - keyWidth / 2, target.position.y, keyWidth, keyHeight);
  }
}

function drawTrailLine(ctx: SKRSContext2D, trail: ReadonlyArray<readonly [number, number]>, ballRadius: number, color: string = TRAIL_COLOR): void {
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < trail.length; i++) {
    const prev = trail[i - 1]!;
    const cur = trail[i]!;
    const frac = i / (trail.length - 1);
    ctx.globalAlpha = 0.05 + 0.45 * frac;
    ctx.lineWidth = Math.max(1, ballRadius * 0.9 * frac);
    ctx.beginPath();
    ctx.moveTo(prev[0], prev[1]);
    ctx.lineTo(cur[0], cur[1]);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawImpacts(ctx: SKRSContext2D, impacts: readonly ImpactEvent[], t: number, ballRadius: number): void {
  ctx.lineWidth = Math.max(1, ballRadius * 0.25);
  for (const impact of impacts) {
    const age = t - impact.timeSec;
    if (age < 0 || age >= PARTICLE_DURATION_SEC) continue;
    const maxRadius = ballRadius * (3 + 5 * impact.impactSize);
    ctx.strokeStyle = impact.color;
    for (let ring = 0; ring < PARTICLE_RING_COUNT; ring++) {
      const ringProgress = age / PARTICLE_DURATION_SEC - ring * PARTICLE_RING_STAGGER;
      if (ringProgress <= 0 || ringProgress >= 1) continue;
      ctx.globalAlpha = (1 - ringProgress) * 0.8;
      ctx.beginPath();
      ctx.arc(impact.x, impact.y, ringProgress * maxRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

function drawBall(ctx: SKRSContext2D, pos: readonly [number, number], ballRadius: number, color: string = BALL_COLOR): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(pos[0], pos[1], ballRadius, 0, Math.PI * 2);
  ctx.fill();
}
