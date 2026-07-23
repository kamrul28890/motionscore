// Deterministic 2D choreography: turns the audio analysis into per-role balls
// that bounce on beat-aligned parabolic arcs (kinematic inversion) and glide on
// rise/fall sections, in a shared world that flows right (x = t * SCROLL_X) and
// drifts down (y += t * DRIFT_Y). No randomness, no simulation — every position
// is a closed-form function of time, so contacts land exactly on the audio.

import type { AudioAnalysis, HitRole, NoteEvent } from '../renderTypes.js';
import { ROLE_COLORS, ROLE_LABELS, ROLE_ORDER } from '../roleMeta.js';
import type { Scene2DSettings } from './settings.js';
import type { Actor, Scene2DModel, SlideSpan, Vec2 } from './types.js';

/** World units travelled rightward per second (time -> x). */
export const SCROLL_X = 6;
/** World units the whole scene drifts downward per second. */
export const DRIFT_Y = 1.1;
/** Vertical separation between adjacent role lanes. */
const LANE_GAP = 2.3;
/** Ball radius in world units. */
export const BALL_R = 0.36;
/** Half-length of a kicker segment. */
const KICKER_HALF = 0.52;

/** Bounce peak = clamp(HOP_K * gapSeconds, HOP_MIN, HOP_MAX), in world units (up). */
const HOP_K = 3.2;
const HOP_MIN = 0.5;
const HOP_MAX = 3.0;
/** A gap longer than this is treated as "resting" (no giant floaty arc). */
const MAX_ARC_SEC = 2.2;

/** Peak glide displacement for a full-intensity rise/fall, in world units. */
const SLIDE_AMOUNT = 1.7;
/** Sampling step (seconds) when baking a slide polyline. */
const SLIDE_STEP = 1 / 30;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** The angle of the "ground" — parallel to the world drift direction. */
const GROUND_ANGLE = Math.atan2(DRIFT_Y, SCROLL_X);

function hopPeak(gapSec: number): number {
  return clamp(HOP_K * gapSec, HOP_MIN, HOP_MAX);
}

/** Slide displacement at time t within a span (a jump-free hump: 0 at both ends). */
function slideOffsetInSpan(span: SlideSpan, t: number): number {
  const span01 = (t - span.t0) / Math.max(1e-6, span.t1 - span.t0);
  const u = clamp(span01, 0, 1);
  return span.dir * span.amount * Math.sin(Math.PI * u);
}

/** Find the slide span containing t, or null. `slides` is sorted by t0. */
function slideAt(slides: SlideSpan[], t: number): SlideSpan | null {
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i]!;
    if (t >= s.t0 && t <= s.t1) return s;
    if (s.t0 > t) break;
  }
  return null;
}

/** Vertical bounce/glide offset (world units; negative = up) for an actor at t. */
function actorOffset(actor: Actor, t: number): number {
  const slide = slideAt(actor.slides, t);
  if (slide) return slideOffsetInSpan(slide, t);

  const times = actor.hitTimes;
  const n = times.length;
  if (n === 0) return 0;

  // Binary search for the last hit <= t.
  let lo = 0;
  let hi = n - 1;
  if (t <= times[0]!) return 0;
  if (t >= times[n - 1]!) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid - 1;
  }
  const t0 = times[lo]!;
  const t1 = times[lo + 1]!;
  const gap = t1 - t0;
  if (gap <= 0 || gap > MAX_ARC_SEC) return 0;
  const u = (t - t0) / gap;
  return -hopPeak(gap) * 4 * u * (1 - u); // parabolic arc, up between beats
}

/** World position of an actor's ball at time t. */
export function sampleActor(actor: Actor, t: number, out?: Vec2): Vec2 {
  const x = t * SCROLL_X;
  const y = actor.laneY + t * DRIFT_Y + actorOffset(actor, t);
  if (out) {
    out.x = x;
    out.y = y;
    return out;
  }
  return { x, y };
}

function countByRole(hits: readonly NoteEvent[]): Map<HitRole, number> {
  const m = new Map<HitRole, number>();
  for (const h of hits) {
    if (!h.role) continue;
    m.set(h.role, (m.get(h.role) ?? 0) + 1);
  }
  return m;
}

/** Pick which roles get a ball: visible, non-empty, busiest first, capped. */
function chooseRoles(analysis: AudioAnalysis, settings: Scene2DSettings): HitRole[] {
  const counts = countByRole(analysis.hits);
  const candidates = ROLE_ORDER.filter((r) => settings.roleVisible[r] && (counts.get(r) ?? 0) > 0);
  candidates.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  return candidates.slice(0, Math.max(1, settings.maxActors));
}

function buildSlides(analysis: AudioAnalysis): SlideSpan[] {
  const spans: SlideSpan[] = [];
  for (const cue of analysis.sectionCues) {
    if (cue.type !== 'rise' && cue.type !== 'fall') continue;
    if (!(cue.endSec > cue.startSec)) continue;
    spans.push({
      t0: cue.startSec,
      t1: cue.endSec,
      dir: cue.type === 'rise' ? -1 : 1,
      amount: clamp(cue.intensity, 0.35, 1) * SLIDE_AMOUNT,
    });
  }
  spans.sort((a, b) => a.t0 - b.t0);
  return spans;
}

/** Build the whole deterministic scene once (call from useMemo). */
export function buildScene2D(
  analysis: AudioAnalysis | null,
  settings: Scene2DSettings,
): Scene2DModel {
  const empty: Scene2DModel = { actors: [], durationSec: 0, bounds: { minY: -2, maxY: 2 } };
  if (!analysis || analysis.hits.length === 0) return empty;

  const roles = chooseRoles(analysis, settings);
  if (roles.length === 0) return empty;

  const durationSec = analysis.durationSec > 0 ? analysis.durationSec : 0;
  const slides = buildSlides(analysis);
  const n = roles.length;

  let minY = Infinity;
  let maxY = -Infinity;

  const actors: Actor[] = roles.map((role, i) => {
    const laneY = (i - (n - 1) / 2) * LANE_GAP;
    const hitTimes = Float64Array.from(
      analysis.hits
        .filter((h) => h.role === role)
        .map((h) => h.startSec)
        .sort((a, b) => a - b),
    );

    const actor: Actor = {
      role,
      color: ROLE_COLORS[role],
      label: ROLE_LABELS[role],
      laneY,
      hitTimes,
      slides,
      kickers: [],
      slidePaths: [],
    };

    // Kickers at every contact that is NOT inside a glide span.
    for (let k = 0; k < hitTimes.length; k++) {
      const t = hitTimes[k]!;
      if (slideAt(slides, t)) continue;
      const p = sampleActor(actor, t);
      actor.kickers.push({ x: p.x, y: p.y, angle: GROUND_ANGLE, half: KICKER_HALF });
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    // Slide polylines: sample the glide path across each span.
    for (const span of slides) {
      const pts: Vec2[] = [];
      for (let t = span.t0; t <= span.t1; t += SLIDE_STEP) {
        const p = sampleActor(actor, t);
        pts.push(p);
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const end = sampleActor(actor, span.t1);
      pts.push(end);
      if (pts.length >= 2) actor.slidePaths.push({ points: pts });
    }

    return actor;
  });

  if (!Number.isFinite(minY)) {
    minY = -2;
    maxY = 2;
  }
  return { actors, durationSec, bounds: { minY, maxY } };
}
