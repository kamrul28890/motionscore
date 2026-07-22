// Ballistic arc solver for MotionScore Stage D (core IP).
//
// `computeBallisticArc` is the closed-form heart of the trajectory solver: given
// a launch point, a target point, a flight duration, and a gravity constant, it
// solves the SUVAT displacement equation for the initial velocity that carries a
// projectile from start to end in exactly that time. Task 5.3's `solveTrajectory`
// chains these arcs between consecutive choreography targets; task 5.2 property-
// tests the arrival accuracy this function guarantees (Requirement 4.1).
//
// Coordinate convention: screen space, y positive *downward*. Gravity is a
// positive constant pulling toward +y ("down"), so an upward launch has a
// negative vy and a downward launch has a positive vy.

/**
 * A single parabolic path segment produced by {@link computeBallisticArc}.
 *
 * `initialVelocity` is the launch velocity `[vx, vy]` (pixels/sec) that, applied
 * from `startPos` under constant gravity for `duration` seconds, lands exactly at
 * `endPos`. `apex` is the highest point the projectile reaches over the flight,
 * retained as a style hint for later arc shaping (e.g. `maxApexHeight`).
 *
 * Defined locally in this package: the shared `@motionscore/types` contracts do
 * not (yet) include `BallisticArc`, and this arc is an internal solver value
 * expressed purely as number tuples, so it carries no cross-package dependency.
 */
export interface BallisticArc {
  /** Launch position `[x, y]` in screen space (pixels, y positive downward). */
  startPos: [number, number];
  /** Arrival position `[x, y]` reached after exactly `duration` seconds. */
  endPos: [number, number];
  /** Launch velocity `[vx, vy]` in pixels/sec (vy < 0 points upward). */
  initialVelocity: [number, number];
  /** Flight time from `startPos` to `endPos`, in seconds (always > 0). */
  duration: number;
  /** Highest point `[x, y]` reached during the flight (smallest y on screen). */
  apex: [number, number];
}

/**
 * Guard that a value is a real, finite number (rejects `NaN` and `±Infinity`).
 * Non-finite inputs would otherwise silently poison the closed-form arithmetic,
 * propagating `NaN`/`Infinity` through every derived velocity and position.
 */
function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

/**
 * Solve for the initial velocity of a ballistic arc between two points.
 *
 * Given a `startPos`, `endPos`, flight `duration`, and `gravity`, this returns
 * the launch velocity that carries a projectile from start to end in exactly
 * `duration` seconds under constant downward gravity, together with the arc's
 * apex for style information.
 *
 * Physics — the SUVAT displacement equation `s = u·t + ½·a·t²`, solved for the
 * initial velocity `u = (s − ½·a·t²) / t`, with y positive downward:
 * - Horizontal has no acceleration, so motion is uniform:
 *   `vx = (endX − startX) / t`.
 * - Vertical is under gravity `g`:
 *   `vy = (endY − startY − ½·g·t²) / t`.
 *
 * The solution is closed-form and exact up to floating-point rounding, so
 * replaying the arc forward (`pos = start + v·t + ½·g·t²`) lands well within
 * 0.001 px of `endPos` (Requirement 4.1 / Property 1).
 *
 * Apex — the vertical velocity crosses zero at `tApex = −vy / g`. The apex is the
 * highest point of the *actual* flight, so `tApex` is clamped to `[0, duration]`:
 * - `vy >= 0` (launched level or already descending) ⇒ `tApex <= 0` ⇒ clamped to
 *   `0`, so the apex is `startPos` — the launch itself is the highest point.
 * - the projectile is still rising at arrival (`tApex > duration`) ⇒ clamped to
 *   `duration`, so the apex is `endPos`.
 * The apex is not part of the arrival guarantee (task 5.2 tests arrival only);
 * clamping simply keeps it a sane point on the visible arc for downstream styling.
 *
 * @param startPos Launch position `[x, y]` (finite pixels, y positive downward).
 * @param endPos Arrival position `[x, y]` (finite pixels).
 * @param duration Flight time in seconds; must be finite and `> 0`.
 * @param gravity Downward acceleration in pixels/sec²; must be finite and `> 0`.
 * @returns The {@link BallisticArc}: the input endpoints, the solved
 *   `initialVelocity`, the `duration`, and the clamped `apex`.
 * @throws {RangeError} if `duration <= 0`, `gravity <= 0`, or any coordinate,
 *   `duration`, or `gravity` is non-finite (`NaN` / `±Infinity`).
 */
export function computeBallisticArc(
  startPos: [number, number],
  endPos: [number, number],
  duration: number,
  gravity: number,
): BallisticArc {
  const [x0, y0] = startPos;
  const [x1, y1] = endPos;

  // --- Preconditions (Requirement 4.1) ---------------------------------------
  if (!isFiniteNumber(duration) || duration <= 0) {
    throw new RangeError(
      `computeBallisticArc: duration must be a finite number > 0, received ${duration}`,
    );
  }
  if (!isFiniteNumber(gravity) || gravity <= 0) {
    throw new RangeError(
      `computeBallisticArc: gravity must be a finite number > 0, received ${gravity}`,
    );
  }
  if (!isFiniteNumber(x0) || !isFiniteNumber(y0)) {
    throw new RangeError(
      `computeBallisticArc: startPos must have finite coordinates, received [${x0}, ${y0}]`,
    );
  }
  if (!isFiniteNumber(x1) || !isFiniteNumber(y1)) {
    throw new RangeError(
      `computeBallisticArc: endPos must have finite coordinates, received [${x1}, ${y1}]`,
    );
  }

  const t = duration;

  // --- Solve initial velocity (closed-form SUVAT) ----------------------------
  // Horizontal: uniform motion (no air resistance, no horizontal acceleration).
  const vx = (x1 - x0) / t;
  // Vertical: s = u·t + ½·g·t²  ⇒  u = (s − ½·g·t²) / t, with s = y1 − y0.
  const vy = (y1 - y0 - 0.5 * gravity * t * t) / t;

  // --- Apex (style hint) -----------------------------------------------------
  // Vertical velocity is zero at tApex = −vy / g. Clamp to the flight window
  // [0, duration] so the apex is the highest point on the *actual* arc (see the
  // doc comment for the two clamped edge cases).
  const tApexRaw = -vy / gravity;
  const tApex = Math.max(0, Math.min(t, tApexRaw));
  const apexX = x0 + vx * tApex;
  const apexY = y0 + vy * tApex + 0.5 * gravity * tApex * tApex;

  return {
    startPos,
    endPos,
    initialVelocity: [vx, vy],
    duration: t,
    apex: [apexX, apexY],
  };
}
