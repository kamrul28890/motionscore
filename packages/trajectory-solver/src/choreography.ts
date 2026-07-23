// Multi-voice choreography solver for MotionScore Stage D (multi-ball, Phase 1).
//
// `solveChoreography` turns a set of `VoicePlan`s (one ball each, produced by
// the musical-mapper's `planVoices`) into a `Choreography` by solving each
// voice's targets independently with `solveTrajectory`, launching each ball
// from its own `startPosition`. Single-ball output is simply a one-voice
// choreography, so this is a strict superset of the existing single-ball path.
//
// See docs/MULTI_BALL_PLAN.md.

import {
  type Choreography,
  type ObjectTrajectory,
  type SolverConfig,
  type Voice,
  type VoicePlan,
} from '@motionscore/types';

import { solveTrajectory } from './solve.js';

/**
 * Solve every voice plan into a full {@link Choreography}.
 *
 * Each voice is solved by {@link solveTrajectory} on that voice's own targets,
 * with the base `config` but the voice's own `startPosition` (so each ball
 * launches from its assigned lane). The resulting trajectory's `objectId` is
 * set to the voice id so multiple balls stay individually addressable.
 *
 * Per-voice trajectories are already contract-validated inside
 * {@link solveTrajectory} (strict ascending keyframes, impacts within the sync
 * tolerance). Canvas-bounds and note-reference validation belong to the
 * pipeline boundary (`validateChoreography`), which has the canvas dimensions.
 *
 * @param plans One or more voice plans (from `planVoices`). Order is preserved.
 * @param config Base solver configuration; `startPosition` is overridden per
 *   voice by the plan's `startPosition`.
 * @returns A {@link Choreography} whose `durationSec` is the latest impact/keyframe
 *   time across all voices (0 when every voice is empty).
 * @throws {ValidationError} propagated from {@link solveTrajectory} if a voice's
 *   trajectory violates the Stage D contract.
 */
export function solveChoreography(
  plans: readonly VoicePlan[],
  config: SolverConfig,
): Choreography {
  const voices: Voice[] = plans.map((plan) => {
    const solved = solveTrajectory(plan.targets, {
      ...config,
      startPosition: plan.startPosition,
    });
    // Give each ball a unique objectId (the voice id) rather than the solver's
    // single-object default, so downstream renderers can address balls apart.
    const trajectory: ObjectTrajectory = {
      objectId: plan.id,
      keyframes: solved.keyframes,
    };
    return { ...plan, trajectory };
  });

  const durationSec = voices.reduce((max, voice) => {
    const last = voice.trajectory.keyframes[voice.trajectory.keyframes.length - 1];
    return last !== undefined ? Math.max(max, last.tSec) : max;
  }, 0);

  return { durationSec, voices };
}
