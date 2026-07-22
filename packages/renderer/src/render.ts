// Frame renderer for MotionScore Stage E.
//
// `render` turns a solved `ObjectTrajectory` plus its `ChoreographyTarget`s into
// a sequence of numbered PNG frames on disk. It samples the scene on a fixed FPS
// grid, interpolating the ball's position between keyframes (Req 5.1), draws the
// targets as colored "piano key" rectangles (Req 5.3), an optional fading trail
// behind the ball (Req 5.4), and expanding-circle particle bursts at each impact
// (Req 5.2). Frames are written as `frame_00001.png`, `frame_00002.png`, ...
// (Req 5.5), and per-frame failures are tolerated up to a 5% budget before the
// render aborts (Req 5.6).
//
// Rendering backend: `@napi-rs/canvas` (Skia, prebuilt N-API binaries) rather
// than the `@pixi/node` originally sketched in the design. `@pixi/node@8`
// requires the native peer dependencies `gl` (headless-gl) and `canvas`
// (node-canvas), which need a full native OpenGL build toolchain and have no
// prebuilt binaries for this Node runtime — they do not install cleanly here.
// `@napi-rs/canvas` ships ABI-stable prebuilt binaries, installs without any
// native compilation, and produces valid PNGs headlessly. The rendering library
// is an implementation detail hidden behind `render()`; downstream stages
// (video export, CLI) only consume the returned frame paths.
//
// Coordinate convention (inherited from Stage D): screen space, y positive
// downward — the same axes the canvas 2D context uses, so positions map directly
// to pixels with no flip.

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type {
  ChoreographyTarget,
  ObjectTrajectory,
  RenderConfig,
} from '@motionscore/types';

import { interpolatePosition } from './interpolate.js';

/**
 * Thrown when rendering must abort because too many frames failed (Req 5.6).
 *
 * Local to this package: the shared `@motionscore/types` error set has no
 * render-stage error, and this condition is internal to Stage E. Subclassing
 * `Error` keeps `instanceof RenderError` checks and stack traces working.
 */
export class RenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RenderError';
  }
}

/** Ball fill color. `RenderConfig` carries no ball color, so this is fixed. */
const BALL_COLOR = '#f5f5fa';

/** Trail color (drawn with a per-segment alpha ramp for the fade). */
const TRAIL_COLOR = '#f5f5fa';

/**
 * Trail length expressed as a duration: the trail shows roughly the ball's path
 * over the last quarter-second, so its on-screen length is fps-independent.
 */
const TRAIL_SECONDS = 0.25;

/** Lifetime of an impact particle burst, in seconds (Req 5.2). */
const PARTICLE_DURATION_SEC = 0.35;

/** Number of concentric, time-staggered rings in a single burst. */
const PARTICLE_RING_COUNT = 3;

/** Per-ring stagger as a fraction of the burst lifetime, so rings expand in sequence. */
const PARTICLE_RING_STAGGER = 0.14;

/** Piano-key rectangle width, as a multiple of the ball radius. */
const KEY_WIDTH_FACTOR = 2.5;

/** Piano-key rectangle height, as a multiple of the ball radius. */
const KEY_HEIGHT_FACTOR = 6;

/** Fraction of total frames allowed to fail before aborting the render (Req 5.6). */
const FRAME_FAILURE_BUDGET = 0.05;

/**
 * A precomputed impact: the time, position, color, and magnitude of a single
 * target strike, derived from a keyframe whose `hitsTarget` is set. Used to draw
 * time-parameterized particle bursts without any persistent per-frame state.
 */
interface ImpactEvent {
  /** Impact time in seconds (the impact keyframe's `tSec`). */
  timeSec: number;
  /** Burst center x (the struck target's position, or the keyframe's if unknown). */
  x: number;
  /** Burst center y. */
  y: number;
  /** Burst color (the struck target's `colorHint`). */
  color: string;
  /** Impact magnitude in [0, 1]; scales the burst's maximum radius. */
  impactSize: number;
}

/** Clamp a value into [0, 1]; NaN collapses to 0. */
function clamp01(value: number): number {
  if (!(value > 0)) {
    return 0;
  }
  return value < 1 ? value : 1;
}

/** Require a config number to be finite and strictly positive, else throw. */
function requirePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RenderError(`render: config.${name} must be a finite number > 0, received ${value}`);
  }
}

/**
 * Decide whether the render should abort: `true` once strictly more than
 * `FRAME_FAILURE_BUDGET` (5%) of the total frames have failed (Req 5.6).
 *
 * Exported for direct unit testing of the threshold boundary, since forcing a
 * genuine per-frame render failure is impractical without mocking the encoder.
 *
 * @param failures Number of frames that have failed so far.
 * @param totalFrames Total frames the render will attempt (must be > 0).
 * @returns `true` when `failures / totalFrames` exceeds 5%.
 */
export function exceedsFailureBudget(failures: number, totalFrames: number): boolean {
  return failures > totalFrames * FRAME_FAILURE_BUDGET;
}

/**
 * Render a trajectory to a sequence of numbered PNG frames.
 *
 * The number of frames is derived from the trajectory's final keyframe time and
 * the configured FPS: `totalFrames = ceil(maxTSec * fps) + 1`, so frames cover
 * `t = 0, 1/fps, 2/fps, ...` inclusive of the last keyframe (the `+1` includes
 * the `t = 0` frame; `ceil` guarantees the final impact is covered even when it
 * falls between grid points). Frames scheduled slightly past the last keyframe
 * freeze on its position (see {@link interpolatePosition}).
 *
 * Per frame it: interpolates the ball position (Req 5.1), clears to
 * `backgroundColor`, draws every target as a `colorHint` rectangle (Req 5.3),
 * an optional fading trail (Req 5.4, when `config.showTrail`), expanding-circle
 * particle bursts for any impact within its lifetime (Req 5.2, unless
 * `config.particlesOnImpact === false`), and finally the ball. The frame is
 * encoded to PNG and written to `config.outputDir` (created if missing) as
 * `frame_%05d.png` with a 1-based, zero-padded index (Req 5.5).
 *
 * Error handling (Req 5.6): each frame's draw/encode/write is wrapped in
 * try/catch; a failure is logged and rendering continues. If the cumulative
 * failure count exceeds 5% of the total frames, the render aborts by throwing a
 * {@link RenderError}. Frames are rendered and written one at a time (a single
 * reused canvas), so memory stays flat regardless of frame count.
 *
 * @param trajectory Solved trajectory whose keyframes drive the ball. An empty
 *   keyframe list produces no frames (returns `[]`).
 * @param targets Choreography targets to draw and to resolve impact
 *   position/color by `noteId`.
 * @param config Render configuration (fps, dimensions, colors, ball radius,
 *   toggles, output directory).
 * @returns The ordered list of absolute paths of the frames written.
 * @throws {RenderError} if a config value is invalid, or if more than 5% of
 *   frames fail to render.
 */
export async function render(
  trajectory: ObjectTrajectory,
  targets: ChoreographyTarget[],
  config: RenderConfig,
): Promise<string[]> {
  const { fps, width, height, backgroundColor, ballRadius, outputDir } = config;

  // --- Validate config (fail fast with a clear message) ----------------------
  requirePositive('fps', fps);
  requirePositive('width', width);
  requirePositive('height', height);
  requirePositive('ballRadius', ballRadius);
  if (typeof outputDir !== 'string' || outputDir.length === 0) {
    throw new RenderError(`render: config.outputDir must be a non-empty string, received ${String(outputDir)}`);
  }

  // Always ensure the output directory exists, even for an empty trajectory, so
  // downstream stages find a directory rather than an ENOENT.
  await mkdir(outputDir, { recursive: true });

  const { keyframes } = trajectory;
  if (keyframes.length === 0) {
    console.warn('render: trajectory has no keyframes; no frames rendered.');
    return [];
  }

  const maxTSec = keyframes[keyframes.length - 1]!.tSec;
  const totalFrames = Math.max(1, Math.ceil(maxTSec * fps) + 1);

  // --- Precompute impacts for particle bursts (Req 5.2) ----------------------
  // Resolve each impact keyframe's target to recover the burst position/color;
  // fall back to the keyframe's own position if the target is missing.
  const targetsById = new Map<string, ChoreographyTarget>();
  for (const target of targets) {
    targetsById.set(target.noteId, target);
  }
  const impacts: ImpactEvent[] = [];
  for (const kf of keyframes) {
    if (kf.hitsTarget === undefined) {
      continue;
    }
    const target = targetsById.get(kf.hitsTarget);
    impacts.push({
      timeSec: kf.tSec,
      x: target ? target.position.x : kf.pos[0],
      y: target ? target.position.y : kf.pos[1],
      color: target ? target.colorHint : BALL_COLOR,
      impactSize: target ? clamp01(target.impactSize) : 0.5,
    });
  }

  const drawTrail = config.showTrail === true;
  const drawParticles = config.particlesOnImpact !== false;
  const trailLength = Math.max(2, Math.round(fps * TRAIL_SECONDS));

  // One canvas, reused for every frame: draw -> encode -> write -> overwrite.
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const framePaths: string[] = [];
  const trail: Array<[number, number]> = [];
  let failures = 0;

  for (let i = 0; i < totalFrames; i++) {
    const t = i / fps;
    const ballPos = interpolatePosition(keyframes, t);

    // Maintain the trailing window of recent positions (ring buffer semantics).
    // Done outside the try so the trail stays temporally correct even if a frame
    // fails to encode.
    trail.push(ballPos);
    if (trail.length > trailLength) {
      trail.shift();
    }

    const frameName = `frame_${String(i + 1).padStart(5, '0')}.png`;
    const framePath = resolve(outputDir, frameName);

    try {
      // Background clear.
      ctx.globalAlpha = 1;
      ctx.fillStyle = backgroundColor;
      ctx.fillRect(0, 0, width, height);

      renderTargets(ctx, targets, ballRadius);
      if (drawTrail) {
        renderTrail(ctx, trail, ballRadius);
      }
      if (drawParticles) {
        renderImpacts(ctx, impacts, t, ballRadius);
      }
      renderBall(ctx, ballPos, ballRadius);

      const png = await canvas.encode('png');
      await writeFile(framePath, png);
      framePaths.push(framePath);
    } catch (err) {
      failures++;
      console.error(
        `render: failed to render frame ${i + 1}/${totalFrames} (${frameName}): ${describeError(err)}`,
      );
      // Abort as soon as the failure budget is exceeded, rather than wasting
      // time rendering the remainder of a doomed run (Req 5.6).
      if (exceedsFailureBudget(failures, totalFrames)) {
        throw new RenderError(
          `render aborted: ${failures} of ${totalFrames} frames failed to render ` +
            `(> ${FRAME_FAILURE_BUDGET * 100}% budget).`,
          { cause: err },
        );
      }
    }
  }

  return framePaths;
}

/** Render each choreography target as a "piano key" rectangle in its `colorHint` (Req 5.3). */
function renderTargets(
  ctx: SKRSContext2D,
  targets: readonly ChoreographyTarget[],
  ballRadius: number,
): void {
  const keyWidth = Math.max(4, ballRadius * KEY_WIDTH_FACTOR);
  const fullHeight = Math.max(8, ballRadius * KEY_HEIGHT_FACTOR);
  ctx.globalAlpha = 1;
  for (const target of targets) {
    // Louder notes (larger impactSize) get taller keys, so the layout reflects
    // dynamics; height stays within [0.5, 1.0] of the full key height.
    const keyHeight = fullHeight * (0.5 + 0.5 * clamp01(target.impactSize));
    const left = target.position.x - keyWidth / 2;
    // The target position marks the key's strike point (its top edge); the key
    // body extends downward from there.
    const top = target.position.y;
    ctx.fillStyle = target.colorHint;
    ctx.fillRect(left, top, keyWidth, keyHeight);
  }
}

/** Render a fading poly-line through the recent ball positions (Req 5.4). */
function renderTrail(
  ctx: SKRSContext2D,
  trail: ReadonlyArray<readonly [number, number]>,
  ballRadius: number,
): void {
  if (trail.length < 2) {
    return;
  }
  ctx.strokeStyle = TRAIL_COLOR;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Each segment fades and thins toward the tail: the newest segment is the most
  // opaque and thickest, older segments progressively fainter.
  for (let i = 1; i < trail.length; i++) {
    const prev = trail[i - 1]!;
    const cur = trail[i]!;
    const frac = i / (trail.length - 1); // 0 (oldest) .. 1 (newest)
    ctx.globalAlpha = 0.05 + 0.45 * frac;
    ctx.lineWidth = Math.max(1, ballRadius * 0.9 * frac);
    ctx.beginPath();
    ctx.moveTo(prev[0], prev[1]);
    ctx.lineTo(cur[0], cur[1]);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * Render expanding-circle particle bursts for every impact currently within its
 * lifetime (Req 5.2). Each burst is a set of time-staggered rings whose radius
 * grows and whose alpha fades over `PARTICLE_DURATION_SEC`, parameterized purely
 * by the elapsed time since impact — so it is deterministic and stateless.
 */
function renderImpacts(
  ctx: SKRSContext2D,
  impacts: readonly ImpactEvent[],
  t: number,
  ballRadius: number,
): void {
  ctx.lineWidth = Math.max(1, ballRadius * 0.25);
  for (const impact of impacts) {
    const age = t - impact.timeSec;
    if (age < 0 || age >= PARTICLE_DURATION_SEC) {
      continue;
    }
    const maxRadius = ballRadius * (3 + 5 * impact.impactSize);
    ctx.strokeStyle = impact.color;
    for (let ring = 0; ring < PARTICLE_RING_COUNT; ring++) {
      // Stagger rings in time so they emanate one after another.
      const ringProgress = age / PARTICLE_DURATION_SEC - ring * PARTICLE_RING_STAGGER;
      if (ringProgress <= 0 || ringProgress >= 1) {
        continue;
      }
      ctx.globalAlpha = (1 - ringProgress) * 0.8;
      ctx.beginPath();
      ctx.arc(impact.x, impact.y, ringProgress * maxRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
}

/** Render the ball as a filled circle at its interpolated position. */
function renderBall(
  ctx: SKRSContext2D,
  pos: readonly [number, number],
  ballRadius: number,
): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = BALL_COLOR;
  ctx.beginPath();
  ctx.arc(pos[0], pos[1], ballRadius, 0, Math.PI * 2);
  ctx.fill();
}

/** Render an unknown thrown value as a readable string for logging. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
