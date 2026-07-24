// Minimal DoodleChaos/Line-Rider-style drawing for the deterministic race plan.
// Black geometry is physical: curves support sustained audio, short catches
// justify exact impacts, and unsupported intervals contain no line at all.

import {
  BALL_R,
  SCROLL_X,
  sampleActor,
  sampleActorVelocity,
  sampleRaceSegment,
  sampleRaceVelocity,
} from './model.js';
import type {
  Actor,
  CameraState,
  Ctx2D,
  RaceContact,
  RaceSegment,
  RenderFrame,
  Scene2DModel,
  SlideSegment,
  Vec2,
} from './types.js';

const PAPER = '#f7f3e8';
const INK = '#151515';

/**
 * A readable stroke colour derived from a ball's fill: keep the hue but clamp
 * brightness so even light balls (yellow, pale green) stay legible as lines on
 * the cream paper. Vivid mid/dark colours pass through unchanged. Cached so
 * each hex is parsed once.
 */
const lineColorCache = new Map<string, string>();
function lineColorFor(fill: string): string {
  const cached = lineColorCache.get(fill);
  if (cached !== undefined) return cached;
  const match = /^#?([0-9a-fA-F]{6})$/.exec(fill.trim());
  if (!match) {
    lineColorCache.set(fill, INK);
    return INK;
  }
  const value = parseInt(match[1]!, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  const maxLuminance = 150;
  const k = luminance > maxLuminance ? maxLuminance / luminance : 1;
  const out = `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
  lineColorCache.set(fill, out);
  return out;
}

const LOOK_BEHIND_SEC = 0.35;
const LOOK_AHEAD_SEC = 2.8;
const CAMERA_MARGIN = 0.11;
const BALL_LEFT_FRACTION = 0.34;
const IMPACT_SQUASH_SEC = 0.12;
const CONTACT_PREVIEW_SEC = 0.1;
const CONTACT_TRAIL_SEC = 0.58;
const TRACK_BEHIND_SEC = 0.48;
const TRACK_AHEAD_SEC = 0.9;

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

const expLerp = (current: number, target: number, rate: number, dt: number): number =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

const pointScratch: Vec2 = { x: 0, y: 0 };
const velocityScratch: Vec2 = { x: 0, y: 0 };

function normalized(value: Vec2): Vec2 {
  const length = Math.hypot(value.x, value.y);
  return length > 1e-9 ? { x: value.x / length, y: value.y / length } : { x: 1, y: 0 };
}

/** Support-side normal for a travelling ball; choose the visually lower side. */
function supportNormal(velocity: Vec2): Vec2 {
  const tangent = normalized(velocity);
  let normal = { x: -tangent.y, y: tangent.x };
  if (normal.y < 0) normal = { x: -normal.x, y: -normal.y };
  return normal;
}

export function createCamera(): CameraState {
  return { x: 0, y: 0, scale: 40, inited: false };
}

/** Linear-interpolated quantile of a pre-sorted ascending array. */
function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = clamp(q, 0, 1) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo]! * (1 - (pos - lo)) + sorted[hi]! * (pos - lo);
}

/**
 * Follow the actor pack and fit zoom to where MOST balls are, not to every
 * transient extreme. The vertical extent uses a trimmed percentile band over
 * time-sampled positions: a ball that briefly jumps high (or free-falls during
 * a rest) contributes only a few samples and is trimmed away, so it may leave
 * frame instead of forcing everyone to shrink. A persistently offset ball (its
 * whole window sits high/low) is NOT trimmed and stays framed. A per-actor-count
 * cap and a raised minimum scale are hard backstops so the view can never zoom
 * out to an unreadable postage stamp regardless of ball count.
 */
function isActorActive(actor: Actor, timeSec: number): boolean {
  return timeSec >= actor.activeStartSec && timeSec <= actor.activeEndSec;
}

/**
 * Framed = active AND not inside a long-silence dormant interval. The camera
 * only frames framed actors, so a ball that has flown off-screen for a long
 * rest never drags the view out to chase it.
 */
function isActorFramed(actor: Actor, timeSec: number): boolean {
  if (!isActorActive(actor, timeSec)) return false;
  for (const dormant of actor.dormantIntervals) {
    if (timeSec >= dormant.startSec && timeSec <= dormant.endSec) return false;
  }
  return true;
}

function updateCamera(model: Scene2DModel, frame: RenderFrame): void {
  const { camera, timeSec, dt, width, height } = frame;
  const samples = 30;
  const t0 = Math.max(0, timeSec - LOOK_BEHIND_SEC);
  const t1 = Math.min(model.durationSec, timeSec + LOOK_AHEAD_SEC);
  const futureTime = Math.min(model.durationSec, timeSec + 1.1);

  let currentXSum = 0;
  let futureXSum = 0;
  let framedCount = 0;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  const ys: number[] = [];

  // Only currently-framed actors are considered. An idle actor (before its
  // first note, after its last, or off-screen during a long silence) must not
  // drag the camera toward an empty region of the world.
  for (const actor of model.actors) {
    if (!isActorFramed(actor, timeSec)) continue;
    framedCount += 1;
    currentXSum += sampleActor(actor, timeSec).x;
    futureXSum += sampleActor(actor, futureTime).x;
    for (let index = 0; index <= samples; index += 1) {
      const sampleTime = t0 + ((t1 - t0) * index) / samples;
      if (!isActorFramed(actor, sampleTime)) continue;
      const point = sampleActor(actor, sampleTime);
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      ys.push(point.y);
    }
  }

  // Nothing framed right now (e.g. every ball is off-screen mid-silence): hold
  // the current camera rather than zooming out to include the off-screen balls.
  if (framedCount === 0) {
    if (camera.inited) return;
    for (const actor of model.actors) {
      currentXSum += sampleActor(actor, timeSec).x;
      futureXSum += sampleActor(actor, futureTime).x;
      ys.push(sampleActor(actor, timeSec).y);
    }
    framedCount = Math.max(1, model.actors.length);
  }

  const actorCount = Math.max(1, framedCount);
  const currentCentroidX = currentXSum / actorCount;
  const futureCentroidX = futureXSum / actorCount;

  if (!Number.isFinite(minX)) {
    minX = currentCentroidX - SCROLL_X;
    maxX = currentCentroidX + SCROLL_X;
  }

  // Trim less per tail as ball count grows: each ball is a 1/n fraction of the
  // samples, so a trim below 1/n keeps every persistent ball while still
  // discarding the much smaller fraction that a brief jump peak occupies.
  ys.sort((a, b) => a - b);
  const trim = clamp(0.5 / actorCount, 0.03, 0.12);
  const loY = quantileSorted(ys, trim);
  const hiY = quantileSorted(ys, 1 - trim);
  const centerY = (loY + hiY) / 2;

  const spreadX = Math.max(SCROLL_X * 1.5, maxX - minX + BALL_R * 8);
  // Cap vertical spread so the fit cannot explode; the allowance grows modestly
  // with ball count because more balls legitimately need a little more room.
  const maxSpreadY = BALL_R * 12 + actorCount * 3.2;
  const spreadY = clamp(hiY - loY + BALL_R * 8, BALL_R * 10, maxSpreadY);
  const fitX = (width * (1 - 2 * CAMERA_MARGIN)) / spreadX;
  const fitY = (height * (1 - 2 * CAMERA_MARGIN)) / spreadY;
  const targetScale = clamp(Math.min(fitX, fitY), 8, 220);
  const visibleWorldWidth = width / targetScale;
  const targetX =
    currentCentroidX +
    (futureCentroidX - currentCentroidX) * 0.18 +
    visibleWorldWidth * (0.5 - BALL_LEFT_FRACTION);
  const targetY = centerY;

  const seeked = Math.abs(dt) > 0.4 || !camera.inited || dt <= 0;
  if (seeked) {
    camera.x = targetX;
    camera.y = targetY;
    camera.scale = targetScale;
    camera.inited = true;
  } else {
    camera.x = expLerp(camera.x, targetX, 5.2, dt);
    camera.y = expLerp(camera.y, targetY, 4.2, dt);
    camera.scale = expLerp(camera.scale, targetScale, 3.2, dt);
  }
}

function segmentXBounds(segment: RaceSegment): [number, number] {
  return [Math.min(segment.p0.x, segment.p1.x), Math.max(segment.p0.x, segment.p1.x)];
}

function visibleProgress(segment: RaceSegment, xMin: number, xMax: number): [number, number] | null {
  const [left, right] = segmentXBounds(segment);
  if (right < xMin || left > xMax) return null;
  const width = Math.max(1e-9, segment.p1.x - segment.p0.x);
  return [
    clamp((xMin - segment.p0.x) / width, 0, 1),
    clamp((xMax - segment.p0.x) / width, 0, 1),
  ];
}

function slideTrackPoint(segment: SlideSegment, u: number): { point: Vec2; normal: Vec2 } {
  const center = sampleRaceSegment(segment, u);
  const velocity = sampleRaceVelocity(segment, u);
  const normal = supportNormal(velocity);
  return {
    point: {
      x: center.x + normal.x * BALL_R,
      y: center.y + normal.y * BALL_R,
    },
    normal,
  };
}

function drawSlideSupports(
  ctx: Ctx2D,
  segment: SlideSegment,
  range: [number, number],
  scale: number,
  ink: string,
): void {
  const dx = Math.abs(segment.p1.x - segment.p0.x) * (range[1] - range[0]);
  // Sparser, fainter struts read as ground hatching under the rail rather than
  // detached ticks floating in space.
  const supportCount = Math.floor((dx * scale) / 96);
  if (supportCount < 1) return;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.9 / scale;
  ctx.globalAlpha = 0.26;
  for (let index = 0; index < supportCount; index += 1) {
    const u = range[0] + ((range[1] - range[0]) * (index + 0.5)) / supportCount;
    const sample = slideTrackPoint(segment, u);
    const length = BALL_R * (0.6 + segment.activity * 0.7);
    ctx.beginPath();
    ctx.moveTo(sample.point.x, sample.point.y);
    ctx.lineTo(
      sample.point.x + sample.normal.x * length,
      sample.point.y + sample.normal.y * length,
    );
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawSlide(
  ctx: Ctx2D,
  segment: SlideSegment,
  range: [number, number],
  scale: number,
  ink: string,
): void {
  drawSlideSupports(ctx, segment, range, scale, ink);
  const pixelLength =
    Math.abs(segment.p1.x - segment.p0.x) * (range[1] - range[0]) * scale;
  const steps = Math.max(4, Math.ceil(pixelLength / 7));
  ctx.strokeStyle = ink;
  ctx.lineWidth = (3.1 + segment.activity * 1.3) / scale;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (let index = 0; index <= steps; index += 1) {
    const u = range[0] + ((range[1] - range[0]) * index) / steps;
    const sample = slideTrackPoint(segment, u).point;
    if (index === 0) ctx.moveTo(sample.x, sample.y);
    else ctx.lineTo(sample.x, sample.y);
  }
  ctx.stroke();
}

function contactEndpoints(contact: RaceContact): [Vec2, Vec2] {
  const half = contact.lineLength / 2;
  return [
    {
      x: contact.surfacePoint.x - contact.tangent.x * half,
      y: contact.surfacePoint.y - contact.tangent.y * half,
    },
    {
      x: contact.surfacePoint.x + contact.tangent.x * half,
      y: contact.surfacePoint.y + contact.tangent.y * half,
    },
  ];
}

function drawContactSupports(
  ctx: Ctx2D,
  contact: RaceContact,
  scale: number,
  alpha: number,
  ink: string,
): void {
  if (contact.supportLength <= 0) return;
  const [left, right] = contactEndpoints(contact);
  const points = contact.style === 'step' ? [contact.surfacePoint] : [left, right];
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.15 / scale;
  ctx.globalAlpha = alpha * (contact.intentionalConvergence ? 0.82 : 0.68);
  for (const point of points) {
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(
      point.x + contact.normal.x * contact.supportLength,
      point.y + contact.normal.y * contact.supportLength,
    );
    ctx.stroke();
  }
  if (contact.style === 'catch') {
    const braceStart = {
      x: left.x + contact.normal.x * contact.supportLength,
      y: left.y + contact.normal.y * contact.supportLength,
    };
    const braceEnd = {
      x: right.x + contact.normal.x * contact.supportLength,
      y: right.y + contact.normal.y * contact.supportLength,
    };
    ctx.beginPath();
    ctx.moveTo(braceStart.x, braceStart.y);
    ctx.lineTo(braceEnd.x, braceEnd.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawContact(
  ctx: Ctx2D,
  contact: RaceContact,
  scale: number,
  alpha: number,
  ink: string,
): void {
  drawContactSupports(ctx, contact, scale, alpha, ink);
  const [left, right] = contactEndpoints(contact);
  ctx.strokeStyle = ink;
  const linePixels =
    contact.style === 'ramp'
      ? 2.6
      : contact.style === 'step'
        ? 3.2
        : 3.5 + contact.strength * 1.4 + (contact.style === 'catch' ? 1 : 0);
  ctx.lineWidth = linePixels / scale;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  if (contact.style === 'catch') {
    // A concave-up cradle the ball drops INTO: rims rise toward the ball
    // (-normal) on both sides and the curve dips to a rounded valley at the
    // contact point. `normal` points from the ball toward the surface, so the
    // rims must be lifted along -normal; lifting along +normal (as before) put
    // the rims below the contact and made an upside-down arch.
    const rim = BALL_R * (0.9 + contact.strength);
    const half = contact.lineLength / 2;
    const start = {
      x: left.x - contact.normal.x * rim,
      y: left.y - contact.normal.y * rim,
    };
    const end = {
      x: right.x - contact.normal.x * rim,
      y: right.y - contact.normal.y * rim,
    };
    // Control points at the bowl floor (the contact), spread along the tangent,
    // pulling the middle down into a smooth U.
    const c1 = {
      x: contact.surfacePoint.x - contact.tangent.x * half * 0.5,
      y: contact.surfacePoint.y - contact.tangent.y * half * 0.5,
    };
    const c2 = {
      x: contact.surfacePoint.x + contact.tangent.x * half * 0.5,
      y: contact.surfacePoint.y + contact.tangent.y * half * 0.5,
    };
    ctx.moveTo(start.x, start.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
  } else {
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function temporalContactAlpha(contact: RaceContact, timeSec: number): number {
  const age = timeSec - contact.timeSec;
  if (age < -CONTACT_PREVIEW_SEC || age > CONTACT_TRAIL_SEC) return 0;
  if (age < 0) {
    const reveal = 1 + age / CONTACT_PREVIEW_SEC;
    return reveal * reveal;
  }
  const decay = 1 - age / CONTACT_TRAIL_SEC;
  return decay * decay;
}

function latestContactIndex(actor: Actor, timeSec: number): number {
  const times = actor.hitTimes;
  if (times.length === 0 || timeSec < times[0]!) return -1;
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (times[middle]! <= timeSec) low = middle;
    else high = middle - 1;
  }
  return low;
}

function drawBall(ctx: Ctx2D, actor: Actor, timeSec: number, scale: number): void {
  const position = sampleActor(actor, timeSec, pointScratch);
  const velocity = sampleActorVelocity(actor, timeSec, velocityScratch);
  const latest = latestContactIndex(actor, timeSec);
  const contact = latest >= 0 ? actor.contacts[latest] : undefined;
  const age = contact ? timeSec - contact.timeSec : Number.POSITIVE_INFINITY;
  const impact = age >= 0 && age < IMPACT_SQUASH_SEC
    ? Math.pow(1 - age / IMPACT_SQUASH_SEC, 2)
    : 0;

  let angle = Math.atan2(velocity.y, velocity.x);
  let radiusX = BALL_R;
  let radiusY = BALL_R;
  if (contact && impact > 0) {
    angle = Math.atan2(contact.tangent.y, contact.tangent.x);
    radiusX = BALL_R * (1 + 0.3 * impact);
    radiusY = BALL_R * (1 - 0.2 * impact);

    // The only impact accent is a physical compression seam attached to the
    // sampled ball and its real contact surface—never a detached baseline ring.
    ctx.strokeStyle = lineColorFor(actor.color);
    ctx.lineWidth = 1.2 / scale;
    ctx.globalAlpha = impact * 0.85;
    ctx.beginPath();
    ctx.moveTo(
      position.x + contact.normal.x * radiusY * 0.72,
      position.y + contact.normal.y * radiusY * 0.72,
    );
    ctx.lineTo(contact.surfacePoint.x, contact.surfacePoint.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = actor.color;
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.2 / scale;
  ctx.beginPath();
  ctx.ellipse(position.x, position.y, radiusX, radiusY, angle, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

export function renderScene2D(ctx: Ctx2D, model: Scene2DModel, frame: RenderFrame): void {
  const { width, height, timeSec } = frame;
  updateCamera(model, frame);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PAPER;
  ctx.globalAlpha = 1;
  ctx.fillRect(0, 0, width, height);
  if (model.actors.length === 0) return;

  const scale = frame.camera.scale;
  const centerX = frame.camera.x;
  const centerY = frame.camera.y;
  ctx.setTransform(
    scale,
    0,
    0,
    scale,
    width / 2 - centerX * scale,
    height / 2 - centerY * scale,
  );
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const halfWidth = width / (2 * scale);
  const xMin = centerX - halfWidth - 1;
  const xMax = centerX + halfWidth + 1;

  // Sustained separated audio is the only source of continuous track. Keep a
  // short look-ahead so the rail reads as terrain without exposing the whole
  // future phrase as a visualizer trace.
  for (const actor of model.actors) {
    if (!isActorActive(actor, timeSec)) continue;
    const ink = lineColorFor(actor.color);
    for (const segment of actor.segments) {
      if (segment.kind !== 'slide') continue;
      if (
        segment.t1 < timeSec - TRACK_BEHIND_SEC ||
        segment.t0 > timeSec + TRACK_AHEAD_SEC
      ) {
        continue;
      }
      const visible = visibleProgress(segment, xMin, xMax);
      if (!visible) continue;
      const duration = Math.max(1e-9, segment.t1 - segment.t0);
      const range: [number, number] = [
        Math.max(visible[0], clamp((timeSec - TRACK_BEHIND_SEC - segment.t0) / duration, 0, 1)),
        Math.min(visible[1], clamp((timeSec + TRACK_AHEAD_SEC - segment.t0) / duration, 0, 1)),
      ];
      if (range[1] > range[0]) drawSlide(ctx, segment, range, scale, ink);
    }
  }

  // A physical impact line reveals with its neural onset, then falls behind the
  // race. No event is filtered: every contact becomes visible at its own time.
  for (const actor of model.actors) {
    if (!isActorActive(actor, timeSec)) continue;
    const ink = lineColorFor(actor.color);
    for (const contact of actor.contacts) {
      const alpha = temporalContactAlpha(contact, timeSec);
      if (alpha <= 0) continue;
      if (contact.surfacePoint.x < xMin - contact.lineLength || contact.surfacePoint.x > xMax + contact.lineLength) {
        continue;
      }
      drawContact(ctx, contact, scale, alpha, ink);
    }
  }

  // Actors are last so their collision/squash remains legible over black track.
  for (const actor of model.actors) {
    if (isActorActive(actor, timeSec)) drawBall(ctx, actor, timeSec, scale);
  }
  ctx.globalAlpha = 1;
}
