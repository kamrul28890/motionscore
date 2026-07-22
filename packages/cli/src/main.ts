// CLI main entry logic for MotionScore (task 9.2).
//
// `main` is the testable core of the command: it parses argv, runs the pipeline,
// prints the success summary (Req 1.3) or a descriptive error (Req 1.2), and
// returns the process exit code (0 success, 1 failure) WITHOUT calling
// `process.exit`. Keeping exit handling out of `main` lets tests assert on the
// returned code and the captured output. The thin bin shim that calls
// `main(process.argv.slice(2)).then((code) => process.exit(code))` is wired in
// task 9.3, so it is intentionally not present here.
//
// Output routing: the success summary goes to stdout (the user's primary
// result); progress and all errors go to stderr, so stdout stays clean for
// scripting.

import { CommanderError } from 'commander';
import {
  ExportError,
  InputError,
  TranscriptionError,
  ValidationError,
} from '@motionscore/types';

import { parseArgs, type ParsedArgs } from './args.js';
import { runPipeline, type PipelineResult } from './pipeline.js';

/**
 * Parse argv, run the pipeline, and report the outcome.
 *
 * @param argv User-supplied arguments only (i.e. `process.argv.slice(2)`), with
 *   no executable/script prefix to strip.
 * @returns The process exit code: `0` on success (or when commander handled
 *   `--help`/`--version`), `1` on any usage or pipeline error.
 */
export async function main(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    return handleParseError(err);
  }

  try {
    const result = await runPipeline(parsed);
    printSummary(result);
    return 0;
  } catch (err) {
    printError(err);
    return 1;
  }
}

/**
 * Translate a failure from {@link parseArgs} into an exit code.
 *
 * commander (via `exitOverride`) throws a {@link CommanderError} for bad usage
 * AND for `--help`/`--version`. Help/version use `exitCode 0` and have already
 * written their text to stdout, so they map to a clean `0`. Genuine usage errors
 * carry a non-zero exit code; since `parseArgs` suppresses commander's own
 * stderr, the message is surfaced here. Any other error (e.g. an
 * {@link InputError} from an unsupported extension) is reported like a pipeline
 * error.
 */
function handleParseError(err: unknown): number {
  if (err instanceof CommanderError) {
    if (err.exitCode === 0) {
      return 0;
    }
    if (err.message.length > 0) {
      process.stderr.write(`${err.message}\n`);
    }
    return 1;
  }
  printError(err);
  return 1;
}

/** Print the success summary statistics to stdout (Req 1.3). */
function printSummary(result: PipelineResult): void {
  const { outputPath, stats } = result;
  const lines = [
    `Done. Wrote ${outputPath}`,
    `  Total notes:     ${stats.totalNotes}`,
    `  Rendered frames: ${stats.renderedFrames}`,
    `  Duration:        ${stats.durationSec.toFixed(2)}s`,
    `  Max sync error:  ${stats.maxSyncErrorMs.toFixed(2)}ms`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** Print a descriptive, one-and-done error message to stderr (Req 1.2). */
function printError(err: unknown): void {
  process.stderr.write(`${formatError(err)}\n`);
}

/**
 * Format a thrown error into a descriptive, user-facing message.
 *
 * Known pipeline error types are labeled by name; a {@link ValidationError}'s
 * message already embeds its stage, field, and value (Req 8.4), and a
 * {@link TranscriptionError}'s captured subprocess stderr is appended when
 * present. Unknown throwables degrade gracefully to their string form.
 */
function formatError(err: unknown): string {
  if (err instanceof TranscriptionError) {
    return err.stderr !== undefined && err.stderr.length > 0
      ? `${err.name}: ${err.message}\n${err.stderr}`
      : `${err.name}: ${err.message}`;
  }
  if (
    err instanceof ValidationError ||
    err instanceof InputError ||
    err instanceof ExportError
  ) {
    return `${err.name}: ${err.message}`;
  }
  if (err instanceof Error) {
    return `Error: ${err.message}`;
  }
  return `Error: ${String(err)}`;
}
