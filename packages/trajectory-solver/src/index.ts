// @motionscore/trajectory-solver
//
// Stage D (core IP): computes physically-plausible ballistic arcs using SUVAT
// kinematics so the object hits each target at its exact time, chaining arcs
// into a complete ObjectTrajectory.
//
// Task 5.1 implements the closed-form ballistic arc solver (`computeBallisticArc`
// and the `BallisticArc` type). Task 5.3 builds `solveTrajectory` on top to chain
// these arcs between consecutive choreography targets into an ObjectTrajectory.

export { computeBallisticArc, type BallisticArc } from './ballistic.js';
export { solveTrajectory } from './solve.js';
