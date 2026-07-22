// Property-based tests for the trajectory chaining solver (task 5.4), Stage D
// (core IP). Covers the three design correctness properties that govern the
// solved trajectory's timing, physics, and ordering:
//
//   - Property 2 (Trajectory timing accuracy)     — Requirement 4.2
//   - Property 3 (Trajectory physical consistency) — Requirement 4.3
//   - Property 4 (Keyframe temporal ordering)      — Requirement 4.4
//
// `solveTrajectory` chains one ballistic arc per target: it emits a single
// launch keyframe at t=0 from `config.startPosition` (carrying the first arc's
// launch velocity), then samples each arc into `ceil(duration * fps)` keyframes,
// tagging the final sample of every arc as the impact that hits its target.
//
// The source is imported from `./solve.js` so tests run against the current
// TypeScript rather than a possibly-stale `dist/` (Vitest resolves the `.js`
// specifier to the sibling `.ts` source). Shared contracts come from
// `@motionscore/types` as type-only imports (erased at runtime).
//
// Coordinate convention (inherited from the solver): screen space, y positive
// *downward*; gravity is a positive constant pulling toward +y.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import type { ChoreographyTarget, SolverConfig } from '@motionscore/types';
import { solveTrajectory } from './solve.js';

// --- Shared constants -------------------------------------------------------

/** Canvas domain the generated targets/start position live within (1080p). */
const CANVAS_WIDTH = 1_920;
const CANVAS_HEIGHT = 1_080;

/**
 * First target time window, in seconds. Bounded away from 0 so the opening arc
 * (from the t=0 launch to the first target) always has a positive duration and
 * the first target is therefore reachable (never skipped by the solver).
 */
const MIN_FIRST_TIME_SEC = 0.2;
const MAX_FIRST_TIME_SEC = 1;

/**
 * Spacing between consecutive targets, in seconds. A floor of 0.1s keeps every
 * arc's duration comfortably positive, so consecutive impacts stay strictly
 * ordered in time and no target collapses to a degenerate (skipped) zero-gap
 * arc. This mirrors musically-realistic note spacing.
 */
const MIN_GAP_SEC = 0.1;
const MAX_GAP_SEC = 1.0;

/** Gravity range in pixels/sec^2 (matches the ballistic solver's test range). */
const MIN_GRAVITY = 300;
const MAX_GRAVITY = 2_000;

/** Keyframe sampling rate range; spans the pipeline's typical 30-60 fps. */
const MIN_FPS = 30;
const MAX_FPS = 60;

/** Sync tolerance (Req 4.2, Property 2): impacts must land within ±15ms. */
const SYNC_TOLERANCE_MS = 15;
const SYNC_TOLERANCE_SEC = SYNC_TOLERANCE_MS / 1_000;

/**
 * Physical-consistency tolerances (Req 4.3, Property 3). The design specifies
 * 0.01 px for position; the small relative terms add headroom for the large
 * intermediate magnitudes a ballistic arc can reach (a fast upward launch can
 * carry the object hundreds of thousands of pixels above the canvas at apex)
 * without weakening the check — a real physics discontinuity is orders of
 * magnitude larger than these bounds. Observed round-trip error is ~1e-10.
 */
const POSITION_ABS_TOL_PX = 0.01;
const VELOCITY_ABS_TOL = 1e-6;
const RELATIVE_TOL = 1e-9;

/** Constant valid hex color for generated targets (colorHint is unused here). */
const TARGET_COLOR = '#4477ff';

// --- Shared arbitraries -----------------------------------------------------

/** Position + impact magnitude of a single target, within the canvas domain. */
interface TargetBody {
  readonly x: number;
  readonly y: number;
  readonly impactSize: number;
}

const targetBodyArb: fc.Arbitrary<TargetBody> = fc.record({
  x: fc.double({ min: 0, max: CANVAS_WIDTH, noNaN: true }),
  y: fc.double({ min: 0, max: CANVAS_HEIGHT, noNaN: true }),
  impactSize: fc.double({ min: 0, max: 1, noNaN: true }),
});

/** A subsequent target: a time gap from its predecessor plus a position body. */
interface SpacedTarget {
  readonly gap: number;
  readonly body: TargetBody;
}

const spacedTargetArb: fc.Arbitrary<SpacedTarget> = fc.record({
  gap: fc.double({ min: MIN_GAP_SEC, max: MAX_GAP_SEC, noNaN: true }),
  body: targetBodyArb,
});

/** Build a `ChoreographyTarget` with a unique, time-ordered note id. */
function toTarget(
  index: number,
  timeSec: number,
  body: TargetBody,
): ChoreographyTarget {
  return {
    noteId: `n${index}`,
    timeSec,
    position: { x: body.x, y: body.y },
    impactSize: body.impactSize,
    colorHint: TARGET_COLOR,
  };
}

/**
 * A chronologically-ordered target sequence of 2-20 targets. The first target
 * lands at `t0` (>= 0.2s) and each subsequent target adds a positive gap, so
 * times are strictly increasing and every target is reachable — the solver
 * hits all of them and skips none (no console warnings, no dropped impacts).
 */
const targetSequenceArb: fc.Arbitrary<ChoreographyTarget[]> = fc
  .record({
    t0: fc.double({
      min: MIN_FIRST_TIME_SEC,
      max: MAX_FIRST_TIME_SEC,
      noNaN: true,
    }),
    first: targetBodyArb,
    // 1-19 subsequent targets → total length 2-20.
    rest: fc.array(spacedTargetArb, { minLength: 1, maxLength: 19 }),
  })
  .map(({ t0, first, rest }): ChoreographyTarget[] => {
    const targets: ChoreographyTarget[] = [toTarget(0, t0, first)];
    let time = t0;
    for (let i = 0; i < rest.length; i += 1) {
      const item = rest[i];
      // In-range access; guard only satisfies noUncheckedIndexedAccess.
      if (item === undefined) {
        continue;
      }
      time += item.gap;
      targets.push(toTarget(i + 1, time, item.body));
    }
    return targets;
  });

/**
 * A valid `SolverConfig`: positive gravity, a start position within the canvas,
 * a sampling fps, and the default 15ms sync tolerance. `gravity` and
 * `startPosition` are the solver's only required fields.
 */
const solverConfigArb: fc.Arbitrary<SolverConfig> = fc
  .record({
    gravity: fc.double({ min: MIN_GRAVITY, max: MAX_GRAVITY, noNaN: true }),
    startX: fc.double({ min: 0, max: CANVAS_WIDTH, noNaN: true }),
    startY: fc.double({ min: 0, max: CANVAS_HEIGHT, noNaN: true }),
    fps: fc.integer({ min: MIN_FPS, max: MAX_FPS }),
  })
  .map(({ gravity, startX, startY, fps }): SolverConfig => ({
    gravity,
    startPosition: [startX, startY],
    fps,
    syncToleranceMs: SYNC_TOLERANCE_MS,
  }));

// --- Shared helpers ---------------------------------------------------------

/**
 * Assert `actual ≈ expected` within a combined absolute + relative tolerance.
 * The relative term scales the bound with the magnitude of `expected`, keeping
 * the check meaningful when a ballistic arc reaches very large coordinates.
 */
function assertClose(
  actual: number,
  expected: number,
  absTol: number,
  label: string,
): void {
  const allowed = absTol + RELATIVE_TOL * Math.abs(expected);
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(allowed);
}

// --- Property 2: trajectory timing accuracy ---------------------------------

describe('solveTrajectory — Property 2: trajectory timing accuracy', () => {
  // **Validates: Requirements 4.2**
  it('lands every impact keyframe within ±15ms of its target timeSec', () => {
    fc.assert(
      fc.property(
        targetSequenceArb,
        solverConfigArb,
        (targets, config) => {
          const trajectory = solveTrajectory(targets, config);
          const targetByNoteId = new Map(
            targets.map((target) => [target.noteId, target] as const),
          );

          let impactCount = 0;
          for (const keyframe of trajectory.keyframes) {
            if (keyframe.hitsTarget === undefined) {
              continue;
            }
            impactCount += 1;
            const target = targetByNoteId.get(keyframe.hitsTarget);
            expect(target, `impact references unknown target ${keyframe.hitsTarget}`).toBeDefined();
            if (target === undefined) {
              continue;
            }
            expect(
              Math.abs(keyframe.tSec - target.timeSec),
            ).toBeLessThanOrEqual(SYNC_TOLERANCE_SEC);
          }

          // Every generated target is reachable, so each yields exactly one
          // impact keyframe — nothing is dropped or duplicated.
          expect(impactCount).toBe(targets.length);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Property 3: trajectory physical consistency ----------------------------

describe('solveTrajectory — Property 3: trajectory physical consistency', () => {
  // **Validates: Requirements 4.3**
  it('keeps consecutive within-arc keyframes consistent with SUVAT + gravity', () => {
    fc.assert(
      fc.property(
        targetSequenceArb,
        solverConfigArb,
        (targets, config) => {
          const trajectory = solveTrajectory(targets, config);
          const keyframes = trajectory.keyframes;
          const gravity = config.gravity;

          for (let i = 0; i + 1 < keyframes.length; i += 1) {
            const current = keyframes[i];
            const next = keyframes[i + 1];
            if (current === undefined || next === undefined) {
              continue;
            }
            // Velocity intentionally changes AT an impact (the object redirects
            // toward the next target), so the segment that *starts* at an impact
            // keyframe crosses an arc boundary and is not gravity-continuous.
            if (current.hitsTarget !== undefined) {
              continue;
            }

            const dt = next.tSec - current.tSec;

            // Position: pos₂ = pos₁ + vel₁·Δt + ½·g·Δt² (x has no gravity term).
            const expectedX = current.pos[0] + current.vel[0] * dt;
            const expectedY =
              current.pos[1] +
              current.vel[1] * dt +
              0.5 * gravity * dt * dt;
            assertClose(next.pos[0], expectedX, POSITION_ABS_TOL_PX, 'pos.x');
            assertClose(next.pos[1], expectedY, POSITION_ABS_TOL_PX, 'pos.y');

            // Velocity: vel₂ = vel₁ + [0, g]·Δt (horizontal velocity constant).
            const expectedVx = current.vel[0];
            const expectedVy = current.vel[1] + gravity * dt;
            assertClose(next.vel[0], expectedVx, VELOCITY_ABS_TOL, 'vel.x');
            assertClose(next.vel[1], expectedVy, VELOCITY_ABS_TOL, 'vel.y');
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});

// --- Property 4: keyframe temporal ordering ---------------------------------

describe('solveTrajectory — Property 4: keyframe temporal ordering', () => {
  // **Validates: Requirements 4.4**
  it('produces keyframes strictly ascending in tSec', () => {
    fc.assert(
      fc.property(
        targetSequenceArb,
        solverConfigArb,
        (targets, config) => {
          const keyframes = solveTrajectory(targets, config).keyframes;
          for (let i = 1; i < keyframes.length; i += 1) {
            const previous = keyframes[i - 1];
            const current = keyframes[i];
            if (previous === undefined || current === undefined) {
              continue;
            }
            expect(current.tSec).toBeGreaterThan(previous.tSec);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- Unit tests: worked examples and edge cases -----------------------------

describe('solveTrajectory — worked example and edge cases', () => {
  it('emits a launch keyframe at t=0 and hits both targets on time', () => {
    const targets: ChoreographyTarget[] = [
      {
        noteId: 'n0',
        timeSec: 0.5,
        position: { x: 500, y: 900 },
        impactSize: 0.5,
        colorHint: TARGET_COLOR,
      },
      {
        noteId: 'n1',
        timeSec: 1.0,
        position: { x: 1_400, y: 900 },
        impactSize: 0.8,
        colorHint: TARGET_COLOR,
      },
    ];
    const config: SolverConfig = {
      gravity: 980,
      startPosition: [960, 100],
      fps: 60,
      syncToleranceMs: SYNC_TOLERANCE_MS,
    };

    const trajectory = solveTrajectory(targets, config);
    expect(trajectory.objectId).toBe('ball_01');

    // Launch keyframe: t=0, at the configured start position, not an impact.
    const launch = trajectory.keyframes[0];
    expect(launch?.tSec).toBe(0);
    expect(launch?.pos).toEqual([960, 100]);
    expect(launch?.hitsTarget).toBeUndefined();

    // Impacts appear in time order and land exactly on their target time/pos.
    const impacts = trajectory.keyframes.filter(
      (keyframe) => keyframe.hitsTarget !== undefined,
    );
    expect(impacts.map((keyframe) => keyframe.hitsTarget)).toEqual(['n0', 'n1']);
    expect(impacts[0]?.tSec).toBeCloseTo(0.5, 10);
    expect(impacts[1]?.tSec).toBeCloseTo(1.0, 10);
    expect(impacts[0]?.pos[0]).toBeCloseTo(500, 6);
    expect(impacts[0]?.pos[1]).toBeCloseTo(900, 6);
    expect(impacts[1]?.pos[0]).toBeCloseTo(1_400, 6);
    expect(impacts[1]?.pos[1]).toBeCloseTo(900, 6);
  });

  it('returns an empty trajectory for empty targets', () => {
    const config: SolverConfig = { gravity: 980, startPosition: [0, 0] };
    expect(solveTrajectory([], config).keyframes).toEqual([]);
  });

  it('hits a single reachable target exactly once', () => {
    const targets: ChoreographyTarget[] = [
      {
        noteId: 'n0',
        timeSec: 0.5,
        position: { x: 100, y: 100 },
        impactSize: 0.3,
        colorHint: TARGET_COLOR,
      },
    ];
    const config: SolverConfig = {
      gravity: 980,
      startPosition: [0, 0],
      fps: 60,
    };

    const trajectory = solveTrajectory(targets, config);
    const impacts = trajectory.keyframes.filter(
      (keyframe) => keyframe.hitsTarget !== undefined,
    );
    expect(impacts).toHaveLength(1);
    expect(impacts[0]?.hitsTarget).toBe('n0');
    expect(impacts[0]?.tSec).toBeCloseTo(0.5, 10);
  });
});
