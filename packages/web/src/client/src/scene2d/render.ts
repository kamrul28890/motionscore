// Camera + drawing for the 2D scene. Framework-agnostic: takes a `Ctx2D`, so
// the same code can drive the browser canvas and (later) the Node exporter.
//
// The camera is purely positional — it follows the balls and frames the track;
// it NEVER reacts to audio energy/beats (no shake). Drawing is strict: white
// paper, near-black track lines, solid role-colored balls.

import type { CameraState, Ctx2D, RenderFrame, Scene2DModel, Vec2 } from './types.js';
import { BALL_R, SCROLL_X, sampleActor } from './model.js';

const PAPER = '#f7f7f4';
const INK = '#161616';

/** Seconds of track kept visible horizontally (sets the default zoom). */
const WINDOW_SEC = 3.0;
/** Fraction of each screen edge kept clear of content. */
const MARGIN = 0.12;
/** Minimum vertical world extent to frame (avoids zooming in too far). */
const MIN_SPREAD = 6;
const MIN_SCALE = 6;
const MAX_SCALE = 220;
/** Ball sits this fraction of the visible window in from the left. */
const BALL_LEFT_FRAC = 0.3;

/** Short motion trail behind each ball (seconds / samples). */
const TRAIL_SEC = 0.14;
const TRAIL_SAMPLES = 5;

const WINDOW_W = WINDOW_SEC * SCROLL_X;

export function createCamera(): CameraState {
  return { x: 0, y: 0, scale: 40, inited: false };
}

const expLerp = (cur: number, target: number, rate: number, dt: number): number =>
  cur + (target - cur) * (1 - Math.exp(-rate * dt));

const scratch: Vec2 = { x: 0, y: 0 };

/** Compute camera targets from actor positions over the look-ahead window. */
function updateCamera(model: Scene2DModel, frame: RenderFrame): void {
  const { camera, timeSec, dt, width, height } = frame;

  // Vertical envelope of every actor across [t-0.5, t+WINDOW_SEC] for a stable
  // fit that anticipates upcoming motion rather than pulsing on each bounce.
  let minY = Infinity;
  let maxY = -Infinity;
  const t0 = timeSec - 0.5;
  const t1 = timeSec + WINDOW_SEC;
  const steps = 22;
  for (const actor of model.actors) {
    for (let s = 0; s <= steps; s++) {
      const tt = t0 + ((t1 - t0) * s) / steps;
      const p = sampleActor(actor, tt < 0 ? 0 : tt, scratch);
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!Number.isFinite(minY)) {
    minY = -MIN_SPREAD / 2;
    maxY = MIN_SPREAD / 2;
  }
  const spreadY = Math.max(MIN_SPREAD, maxY - minY + BALL_R * 4);

  const sVert = (height * (1 - 2 * MARGIN)) / spreadY;
  const sHorz = (width * (1 - 2 * MARGIN)) / WINDOW_W;
  let targetScale = Math.min(sVert, sHorz);
  if (targetScale < MIN_SCALE) targetScale = MIN_SCALE;
  if (targetScale > MAX_SCALE) targetScale = MAX_SCALE;

  const ballX = timeSec * SCROLL_X;
  const targetX = ballX + WINDOW_W * (0.5 - BALL_LEFT_FRAC);
  const targetY = (minY + maxY) / 2;

  const seeked = Math.abs(dt) > 0.4 || !camera.inited || dt <= 0;
  if (seeked) {
    camera.x = targetX;
    camera.y = targetY;
    camera.scale = targetScale;
    camera.inited = true;
  } else {
    camera.x = expLerp(camera.x, targetX, 6, dt);
    camera.y = expLerp(camera.y, targetY, 4, dt);
    camera.scale = expLerp(camera.scale, targetScale, 3.5, dt);
  }
}

function drawActorTrail(ctx: Ctx2D, actor: Scene2DModel['actors'][number], t: number): void {
  ctx.strokeStyle = actor.color;
  ctx.lineWidth = BALL_R * 1.05;
  ctx.lineCap = 'round';
  ctx.globalAlpha = 0.28;
  ctx.beginPath();
  for (let i = 0; i < TRAIL_SAMPLES; i++) {
    const tt = t - (TRAIL_SEC * i) / (TRAIL_SAMPLES - 1);
    if (tt < 0) break;
    const p = sampleActor(actor, tt, scratch);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Update the camera and draw one frame. */
export function renderScene2D(ctx: Ctx2D, model: Scene2DModel, frame: RenderFrame): void {
  const { width, height } = frame;

  updateCamera(model, frame);
  const s = frame.camera.scale;
  const cx = frame.camera.x;
  const cy = frame.camera.y;

  // Paper background (identity transform).
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);

  if (model.actors.length === 0) return;

  // World -> screen transform.
  ctx.setTransform(s, 0, 0, s, width / 2 - cx * s, height / 2 - cy * s);

  const halfW = width / 2 / s;
  const xMin = cx - halfW - 2;
  const xMax = cx + halfW + 2;

  const trackW = 2.2 / s; // ~constant on-screen thickness
  const ballOutline = 2 / s;

  // --- Track (near-black): slide strokes, then kicker ticks ---
  ctx.strokeStyle = INK;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const actor of model.actors) {
    // Slide polylines
    for (const path of actor.slidePaths) {
      const pts = path.points;
      if (pts.length < 2) continue;
      if (pts[pts.length - 1]!.x < xMin || pts[0]!.x > xMax) continue;
      ctx.lineWidth = trackW;
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.stroke();
    }
    // Kicker ticks
    ctx.lineWidth = trackW;
    for (const k of actor.kickers) {
      if (k.x < xMin || k.x > xMax) continue;
      const dx = Math.cos(k.angle) * k.half;
      const dy = Math.sin(k.angle) * k.half;
      ctx.beginPath();
      ctx.moveTo(k.x - dx, k.y - dy);
      ctx.lineTo(k.x + dx, k.y + dy);
      ctx.stroke();
    }
  }

  // --- Balls (solid role colors) ---
  for (const actor of model.actors) {
    const p = sampleActor(actor, frame.timeSec, scratch);
    if (p.x < xMin - BALL_R || p.x > xMax + BALL_R) continue;
    const px = p.x;
    const py = p.y;
    drawActorTrail(ctx, actor, frame.timeSec);
    ctx.fillStyle = actor.color;
    ctx.beginPath();
    ctx.arc(px, py, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = ballOutline;
    ctx.beginPath();
    ctx.arc(px, py, BALL_R, 0, Math.PI * 2);
    ctx.stroke();
  }
}
