// @motionscore/types
//
// Shared data-contract types (NoteEvent, ChoreographyTarget, TrajectoryKeyframe,
// ObjectTrajectory), configuration interfaces (CLIOptions, LayoutConfig,
// SolverConfig, RenderConfig, ExportConfig), and structured error types
// (InputError, TranscriptionError, ExportError, ValidationError) for the
// MotionScore pipeline.
//
// Also exports the runtime data-contract validators (validateNoteEvents,
// validateChoreographyTargets, validateObjectTrajectory) run at stage
// boundaries.

export * from './data-contracts.js';
export * from './config.js';
export * from './errors.js';
export * from './validators.js';
