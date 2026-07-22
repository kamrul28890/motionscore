// Trajectory chaining solver for MotionScore Stage D (core IP).
//
// `solveTrajectory` turns a time-ordered list of choreography targets into a
// dense `ObjectTrajectory`. It chains one ballistic arc per target (reusing
// `computeBallisticArc` from task 5.1 — the SUVAT math is never reimplemented
// here), samples each arc into keyframes at the configured FPS, and marks the
// final keyframe of every arc as the impact that hits its target. Combined with
// the arrival guarantee of `computeBallisticArc` (Req 4.1), this produces
// frame-accurate, physically-plausible motion that lands on every reachable
// note within the sync tolerance (Reqs 4.2-4.6).
//
// Coordinate convention (inherited from `computeBallisticArc`): screen space,
// y positive *downward*; gravity is a positive constant pulling toward +y.

import {
  validateObjectTrajectory,
  type ChoreographyTarget,
  type ObjectTrajectory,
  type SolverConfig,
  type TrajectoryKeyframe,
} from '@motionscore/types';
import { computeBallisticArc } from './ballistic.js';

/** Identifier assigned to the single physics object solved for in M1. */
const OBJECT_ID = 'ball_01';

/**
 * Keyframe sampling rate (frames/sec) used when `SolverConfig.fps` is omitted.
 * Matches the pipeline-wide default frame rate (CLI `--fps`, `RenderConfig.fps`).
 */
const DEFAULT_FPS = 60;

/** Sync tolerance (ms) used when `SolverConfig.syncToleranceMs` is omitted (Req 4.2). */
const DEFAULT_SYNC_TOLERANCE_MS = 15;

/**
 * M1 launch-speed ceiling, in pixels/sec. When the arc required to reach a
 * target within the available time has a launch speed above this value, the
 * target is treated as unreachable: the solver logs a warning and skips it
 * (Requirement 4.5), leaving the rest of the trajectory intact.
 *
 * `SolverConfig` has no explicit `maxVelocity` field in M1, so this internal
 * constant stands in for the "configurable maximum" the requirement anticipates.
 * It is deliberately generous — ~520 screen-widths/sec at 1080p — so it never
 * trips on musically-realistic spacing (every reachable target is still hit) and
 * fires only on numerically-degenerate targets that are near-simultaneous yet
 * far apart, which would otherwise demand absurd velocities. A future explicit
 * `SolverConfig.maxVelocity` can supersede this default.
 */
const DEFAULT_MAX_LAUNCH_SPEED = 1_000_000;

/**
 * Lexicographic (ASCII code-point) string comparison, used as a stable,
 * locale-independent tiebreak so solver output is deterministic.
 */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Chain ballistic arcs into a complete `ObjectTrajectory` that hits each target
 * at its exact time (Stage D output).
 *
 * The solver sorts a copy of `targets` by time, then walks them in order. For
 * each target it computes the arc from the current position/time to the target
 * (via {@link computeBallisticArc}) and samples that arc into
 * `ceil(duration * fps)` evenly-spaced keyframes; the final sample lands on the
 * target and is tagged with `hitsTarget = target.noteId`. A single launch
 * keyframe is emitted at `t = 0` from `config.startPosition`, carrying the first
 * arc's launch velocity so the very first step is physically consistent.
 *
 * Guarantees (design "solveTrajectory()" spec, Requirement 4):
 * - **Arrival (4.1):** each arc uses the closed-form SUVAT velocity, so sampled
 *   positions follow `pos = p0 + v0·t + ½·g·t²` exactly (up to float rounding).
 * - **Timing (4.2):** an impact's `tSec` is `currentTime + duration ===
 *   target.timeSec`, i.e. exact — comfortably within `syncToleranceMs`.
 * - **Physical consistency (4.3):** within an arc, consecutive keyframes satisfy
 *   the gravity update `pos₂ = pos₁ + vel₁·Δt + ½·g·Δt²`. Velocity is allowed to
 *   change *at* an impact (the object redirects toward the next target).
 * - **Strict ordering (4.4):** samples use strictly increasing offsets and each
 *   arc starts strictly after the previous impact, so `tSec` strictly ascends.
 * - **Unreachable targets (4.5):** a target whose required launch speed exceeds
 *   {@link DEFAULT_MAX_LAUNCH_SPEED} is skipped with a warning; the trajectory
 *   stays valid (just shorter). Degenerate/duplicate timings (duration ≤ 0) are
 *   likewise skipped so keyframes never collide or go non-increasing.
 * - **Style params (4.6):** `maxApexHeight` / `preferredArcRatio` are accepted
 *   as reserved pass-through inputs; arc shaping is deferred to M3.
 *
 * Before returning, the result is validated against the Stage D contract
 * ({@link validateObjectTrajectory}) so any ordering or timing regression throws
 * a `ValidationError` rather than silently corrupting downstream stages.
 *
 * @param targets Choreography targets to hit (any order; sorted internally). The
 *   caller's array is not mutated.
 * @param config Solver configuration: `gravity` and `startPosition` are
 *   required; `fps` (default 60), `syncToleranceMs` (default 15), and the style
 *   params are optional.
 * @returns The chained {@link ObjectTrajectory} (`objectId: 'ball_01'`). Empty
 *   `targets` (or all-skipped targets) yield an empty keyframe list.
 * @throws {ValidationError} if the produced trajectory violates the Stage D
 *   contract (strict ascending `tSec`, impacts within `syncToleranceMs`).
 * @throws {RangeError} propagated from {@link computeBallisticArc} if `gravity`
 *   is not a finite number `> 0` or a target position is non-finite.
 */
export function solveTrajectory(
  targets: ChoreographyTarget[],
  config: SolverConfig,
): ObjectTrajectory {
  const { gravity } = config;
  const fps = config.fps ?? DEFAULT_FPS;
  const syncToleranceMs = config.syncToleranceMs ?? DEFAULT_SYNC_TOLERANCE_MS;

  // Style parameters (Requirement 4.6): accepted but not yet applied. Arc
  // shaping (honoring maxApexHeight / preferredArcRatio) is deferred to M3;
  // referencing them keeps them live, documented pass-through inputs rather
  // than dead config fields.
  void config.maxApexHeight;
  void config.preferredArcRatio;

  // Sort a copy so the caller's array is never mutated. Targets are ordered by
  // time (Req 4 precondition); noteId breaks ties so equal-time targets resolve
  // deterministically — the earliest in this order wins the time slot and the
  // rest collapse to zero duration and are skipped below.
  const sortedTargets = [...targets].sort(
    (a, b) => a.timeSec - b.timeSec || compareStrings(a.noteId, b.noteId),
  );

  const keyframes: TrajectoryKeyframe[] = [];
  let currentPos: [number, number] = [
    config.startPosition[0],
    config.startPosition[1],
  ];
  let currentTime = 0;
  let startEmitted = false;

  for (const target of sortedTargets) {
    const endPos: [number, number] = [target.position.x, target.position.y];
    const duration = target.timeSec - currentTime;

    // Degenerate/duplicate timing guard (Req 4.4): a non-positive duration — a
    // target at or before the current time, e.g. a duplicate `timeSec` or a
    // target at t=0 while the object launches at t=0 — cannot yield a strictly
    // later impact keyframe. Skip it so keyframes stay strictly ascending and
    // never carry NaN/Infinity from a divide-by-(≤0) in the arc solver.
    if (!(duration > 0)) {
      console.warn(
        `solveTrajectory: skipping target ${JSON.stringify(
          target.noteId,
        )} at t=${target.timeSec}s — non-positive time gap (${duration}s) from the previous position.`,
      );
      continue;
    }

    const arc = computeBallisticArc(currentPos, endPos, duration, gravity);
    const [vx, vy] = arc.initialVelocity;

    // Reachability guard (Req 4.5): if the required launch speed exceeds the
    // ceiling, the target is unreachable in the available time — warn and skip,
    // advancing neither position nor time so the next target is solved from the
    // current (unchanged) state, keeping the trajectory valid.
    const launchSpeed = Math.hypot(vx, vy);
    if (launchSpeed > DEFAULT_MAX_LAUNCH_SPEED) {
      console.warn(
        `solveTrajectory: skipping unreachable target ${JSON.stringify(
          target.noteId,
        )} at t=${target.timeSec}s — required launch speed ${launchSpeed.toFixed(
          1,
        )} px/s exceeds the ${DEFAULT_MAX_LAUNCH_SPEED} px/s maximum.`,
      );
      continue;
    }

    // Emit the launch keyframe exactly once, at t=0, carrying the first real
    // arc's launch velocity so the step to the first sampled keyframe obeys the
    // gravity update (Req 4.3). Subsequent arcs do NOT re-emit their start point
    // (it is the previous arc's impact keyframe), avoiding a duplicate keyframe
    // at the arc boundary.
    if (!startEmitted) {
      keyframes.push({
        tSec: currentTime,
        pos: [currentPos[0], currentPos[1]],
        vel: [vx, vy],
      });
      startEmitted = true;
    }

    // Sample the arc into keyframes at FPS density. `steps` is at least 1 so a
    // sub-frame arc still emits its impact. Position/velocity come straight from
    // the closed-form arc: pos = p0 + v0·t + ½·g·t², vel = v0 + g·t (x: g = 0).
    const steps = Math.max(1, Math.ceil(duration * fps));
    for (let step = 1; step <= steps; step++) {
      const dt = (step / steps) * duration;
      const px = currentPos[0] + vx * dt;
      const py = currentPos[1] + vy * dt + 0.5 * gravity * dt * dt;
      const keyframe: TrajectoryKeyframe = {
        tSec: currentTime + dt,
        pos: [px, py],
        vel: [vx, vy + gravity * dt],
      };
      // The final sample (step === steps) lands exactly on the target: dt equals
      // `duration`, so tSec === currentTime + duration === target.timeSec. Tag
      // it as the impact (Req 4.2 timing is then exact, not merely in-tolerance).
      if (step === steps) {
        keyframe.hitsTarget = target.noteId;
      }
      keyframes.push(keyframe);
    }

    currentPos = endPos;
    currentTime = target.timeSec;
  }

  const trajectory: ObjectTrajectory = { objectId: OBJECT_ID, keyframes };

  // Enforce the Stage D output contract before returning (Req 8.3): strictly
  // ascending keyframes, and every impact within tolerance of its referenced
  // target. Skipped targets simply have no impact keyframe — the validator only
  // checks emitted impacts, so a valid (possibly shorter) trajectory passes.
  validateObjectTrajectory(trajectory, sortedTargets, syncToleranceMs);

  return trajectory;
}
