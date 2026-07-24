// @motionscore/cli
//
// CLI entry point: parses arguments, detects input type, and orchestrates the
// pipeline (extract -> map -> solve -> render -> export) with data-contract
// validation at each stage boundary.
//
// - Task 9.1 implemented the argument parser, input-type detection, and
//   input-existence validation (`args.ts`).
// - Task 9.2 (this) adds `runPipeline` (the wired pipeline) and `main` (parse ->
//   run -> report, returning an exit code). `main` never calls `process.exit`;
//   the executable bin shim that does — `main(process.argv.slice(2)).then((code)
//   => process.exit(code))` — is added in task 9.3 along with the package `bin`
//   entry and build scripts.

export { parseArgs, buildProgram, detectInputType, assertInputReadable } from './args.js';
export type { ParsedArgs, InputType } from './args.js';

export { runPipeline } from './pipeline.js';
export type { PipelineResult } from './pipeline.js';

// Re-exported so the web server can auto-prefer neural stems when a GPU is
// available without depending on @motionscore/note-extractor directly.
export { detectStemsGpuAvailable } from '@motionscore/note-extractor';

export { main } from './main.js';
