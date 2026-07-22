// Keyframe position interpolation for the MotionScore renderer (Stage E).
//
// The trajectory solver (Stage D) emits dense, strictly time-sorted keyframes.
// The renderer samples the scene on its own fixed FPS grid (t = frameIndex /
// fps), which rarely lands exactly on a keyframe time, so this module recovers
// the ball's position at an arbitrary time by linearly interpolating between the
// two surrounding keyframes (Requirement 5.1 — smooth motion).
//
// Coordinate convention (inherited from Stage D): screen space, y positive
// downward. Interpolation is purely on the stored `pos` values, so it is
// agnostic to the convention.

import type { TrajectoryKeyframe } from '@motionscore/types';

/**
 * Linearly interpolate the object's `[x, y]` position at time `t` from a
 * strictly time-ordered keyframe list.
 *
 * Behaviour:
 * - **Clamp before the start:** `t <= keyframes[0].tSec` returns the first
 *   keyframe's position (no extrapolation backwards).
 * - **Clamp after the end:** `t >= keyframes[last].tSec` returns the last
 *   keyframe's position (no extrapolation past the final impact).
 * - **Between keyframes:** finds the segment `[a, b]` with
 *   `a.tSec <= t < b.tSec` (via binary search) and linearly interpolates each
 *   axis by `frac = (t - a.tSec) / (b.tSec - a.tSec)`.
 *
 * The keyframes are assumed to be sorted strictly ascending by `tSec` — the
 * Stage D output contract, enforced by `validateObjectTrajectory`. The strict
 * ordering guarantees every segment has a positive time span, so the fraction
 * is always well-defined.
 *
 * @param keyframes Non-empty, strictly time-sorted keyframe list. Callers guard
 *   the empty case (an empty trajectory renders no frames).
 * @param t Query time in seconds.
 * @returns The interpolated `[x, y]` position (a fresh tuple).
 */
export function interpolatePosition(
  keyframes: readonly TrajectoryKeyframe[],
  t: number,
): [number, number] {
  const n = keyframes.length;

  // Clamp at the lower bound: at or before the first keyframe, hold the launch
  // position rather than extrapolating backwards.
  const first = keyframes[0]!;
  if (t <= first.tSec) {
    return [first.pos[0], first.pos[1]];
  }

  // Clamp at the upper bound: at or after the last keyframe (the final impact),
  // hold the final position. Frames scheduled slightly past the last keyframe
  // (the frame grid can overshoot the trajectory's end) therefore freeze on it.
  const last = keyframes[n - 1]!;
  if (t >= last.tSec) {
    return [last.pos[0], last.pos[1]];
  }

  // Binary-search for the segment [lo, lo + 1] such that
  // keyframes[lo].tSec <= t < keyframes[lo + 1].tSec. The bounds checks above
  // guarantee 0 <= lo < n - 1 on exit.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (keyframes[mid]!.tSec <= t) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const a = keyframes[lo]!;
  const b = keyframes[lo + 1]!;
  const span = b.tSec - a.tSec;
  // span > 0 by the strict-ordering contract; the ternary is a defensive guard
  // against a degenerate (equal-time) pair that would otherwise divide by zero.
  const frac = span > 0 ? (t - a.tSec) / span : 0;

  return [
    a.pos[0] + frac * (b.pos[0] - a.pos[0]),
    a.pos[1] + frac * (b.pos[1] - a.pos[1]),
  ];
}
