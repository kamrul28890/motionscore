// Property-based tests for the ballistic arc calculator (task 5.2), Stage D
// (core IP). Covers the design's headline correctness property:
//
//   - Property 1 (Ballistic arc arrival accuracy) — Requirement 4.1
//
// `computeBallisticArc` solves the SUVAT displacement equation for the launch
// velocity that carries a projectile from start to end in exactly `duration`
// seconds under constant gravity. Property 1 verifies that guarantee directly:
// take the returned `initialVelocity`, simulate the arc forward under the same
// gravity for the same duration, and confirm the projectile lands within
// 0.001 px of the requested end position.
//
// The source is imported from `./ballistic.js` so tests run against the current
// TypeScript rather than a possibly-stale `dist/` (Vitest resolves the `.js`
// specifier to the sibling `.ts` source).
//
// Coordinate convention (inherited from the implementation): screen space, y
// positive *downward*; gravity is a positive constant pulling toward +y, so an
// upward launch has a negative vy.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { computeBallisticArc } from './ballistic.js';

// --- Shared constants -------------------------------------------------------

/**
 * Arrival tolerance from Requirement 4.1 / Property 1: the forward-simulated
 * landing point must be within this many pixels of the requested end position.
 */
const ARRIVAL_TOLERANCE_PX = 0.001;

/**
 * Position bounds for the generators, fixed to the realistic canvas domain:
 * [0, 4000] px comfortably covers a 4K (3840x2160) frame. Within these bounds —
 * combined with the duration/gravity ranges below — the closed-form solution's
 * float round-trip error stays on the order of 1e-11 px, many orders of
 * magnitude under the 0.001 px tolerance, so the property holds robustly. Per
 * the task guidance, the domain is constrained to realistic magnitudes rather
 * than the tolerance being loosened.
 */
const POSITION_MIN = 0;
const POSITION_MAX = 4_000;

// --- Shared arbitraries -----------------------------------------------------

/** A single finite coordinate within the realistic canvas domain. */
const coordinateArb: fc.Arbitrary<number> = fc.double({
  min: POSITION_MIN,
  max: POSITION_MAX,
  noNaN: true,
});

/** A finite `[x, y]` position within the canvas domain. */
const positionArb: fc.Arbitrary<[number, number]> = fc.tuple(
  coordinateArb,
  coordinateArb,
);

/**
 * Flight duration in seconds, in [0.05, 5]. Bounded away from 0 so the solver's
 * divide-by-duration is well-conditioned (matches the task's specified range).
 */
const durationArb: fc.Arbitrary<number> = fc.double({
  min: 0.05,
  max: 5,
  noNaN: true,
});

/** Gravity in pixels/sec^2, in [100, 2000] (matches the task's specified range). */
const gravityArb: fc.Arbitrary<number> = fc.double({
  min: 100,
  max: 2_000,
  noNaN: true,
});

// --- Property 1: ballistic arc arrival accuracy -----------------------------

describe('computeBallisticArc — Property 1: ballistic arc arrival accuracy', () => {
  // **Validates: Requirements 4.1**
  it('lands within 0.001 px of endPos when the arc is simulated forward', () => {
    fc.assert(
      fc.property(
        positionArb,
        positionArb,
        durationArb,
        gravityArb,
        (startPos, endPos, duration, gravity) => {
          const arc = computeBallisticArc(startPos, endPos, duration, gravity);
          const [vx, vy] = arc.initialVelocity;
          const [startX, startY] = startPos;
          const [endX, endY] = endPos;

          // Simulate the arc forward under constant gravity (y positive
          // downward): x is uniform motion, y adds the ½·g·t² gravity drop. The
          // gravity term uses the same operand order as the implementation so
          // no avoidable rounding divergence is introduced.
          const finalX = startX + vx * duration;
          const finalY =
            startY + vy * duration + 0.5 * gravity * duration * duration;

          expect(Math.abs(finalX - endX)).toBeLessThan(ARRIVAL_TOLERANCE_PX);
          expect(Math.abs(finalY - endY)).toBeLessThan(ARRIVAL_TOLERANCE_PX);
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

// --- Unit tests: worked example and preconditions ---------------------------

describe('computeBallisticArc — worked example (design) and preconditions', () => {
  it('solves the design worked example [100,200]->[500,200] in 0.8s @ g=980', () => {
    const arc = computeBallisticArc([100, 200], [500, 200], 0.8, 980);

    // Design: initialVelocity ~ [500, -392] (rightward and upward).
    expect(arc.initialVelocity[0]).toBeCloseTo(500, 6);
    expect(arc.initialVelocity[1]).toBeCloseTo(-392, 6);

    // Endpoints and duration are echoed back unchanged.
    expect(arc.startPos).toEqual([100, 200]);
    expect(arc.endPos).toEqual([500, 200]);
    expect(arc.duration).toBe(0.8);

    // Forward-sim lands back at the requested end position (same tolerance the
    // property asserts, expressed via toBeCloseTo's 6-digit precision).
    const [vx, vy] = arc.initialVelocity;
    const finalX = 100 + vx * 0.8;
    const finalY = 200 + vy * 0.8 + 0.5 * 980 * 0.8 * 0.8;
    expect(finalX).toBeCloseTo(500, 6);
    expect(finalY).toBeCloseTo(200, 6);
  });

  it('throws a RangeError when duration <= 0', () => {
    expect(() => computeBallisticArc([0, 0], [10, 10], 0, 980)).toThrow(
      RangeError,
    );
    expect(() => computeBallisticArc([0, 0], [10, 10], -1.5, 980)).toThrow(
      RangeError,
    );
  });

  it('throws a RangeError when gravity <= 0', () => {
    expect(() => computeBallisticArc([0, 0], [10, 10], 1, 0)).toThrow(
      RangeError,
    );
    expect(() => computeBallisticArc([0, 0], [10, 10], 1, -50)).toThrow(
      RangeError,
    );
  });
});
