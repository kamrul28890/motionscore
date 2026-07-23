// @motionscore/cli — CLI argument parsing (task 9.1)
//
// This module implements ONLY the pieces that turn a raw argv into validated,
// fully-defaulted options: the commander-based argument parser, input-type
// detection by extension, and an input-existence/readability check. Pipeline
// orchestration is task 9.2 and the bin/build wiring is task 9.3; nothing here
// touches the pipeline or calls `process.exit`.
//
// commander 15 is a native ESM package (its package.json declares
// `"type": "module"`), so its named exports import directly under nodenext —
// no default-import/interop dance is required.

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { extname } from 'node:path';

import { Command, InvalidArgumentError, Option } from 'commander';
import { InputError, type CLIOptions } from '@motionscore/types';

/** Default target frame rate when `--fps` is omitted (Requirement 1.4). */
const DEFAULT_FPS = 60;
/** Default video width in pixels when `--width` is omitted. */
const DEFAULT_WIDTH = 1920;
/** Default video height in pixels when `--height` is omitted. */
const DEFAULT_HEIGHT = 1080;

/** Supported layout strategies; the first entry is the default. */
const LAYOUTS = ['piano-keys', 'lanes'] as const;
type Layout = (typeof LAYOUTS)[number];
/** Default layout strategy when `--layout` is omitted. */
const DEFAULT_LAYOUT: Layout = 'piano-keys';

/** Supported extraction modes; the first entry is the default. */
const MODES = ['auto', 'beats', 'onsets', 'stems', 'notes'] as const;
type Mode = (typeof MODES)[number];
/** Default extraction mode when `--mode` is omitted. */
const DEFAULT_MODE: Mode = 'auto';

/** Supported ball-grouping strategies; the first entry is the default. */
const BALLS = ['single', 'per-role'] as const;
type Balls = (typeof BALLS)[number];
/** Default ball grouping when `--balls` is omitted. */
const DEFAULT_BALLS: Balls = 'single';

/** Extensions routed to the MIDI parser (lower-cased, leading dot included). */
const MIDI_EXTENSIONS: ReadonlySet<string> = new Set(['.mid', '.midi']);
/** Extensions routed to the audio transcriber (lower-cased, leading dot). */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['.wav', '.mp3', '.flac', '.ogg']);

/** Input kind detected from a file extension, used to route the pipeline. */
export type InputType = 'midi' | 'audio';

/**
 * Result of {@link parseArgs}: the normalized options plus the detected input
 * kind so downstream orchestration (task 9.2) can route MIDI vs. audio without
 * re-inspecting the extension.
 */
export interface ParsedArgs {
  /** Normalized, fully-defaulted CLI options. */
  options: CLIOptions;
  /** Input kind detected from `options.input`'s extension. */
  inputType: InputType;
}

/**
 * The exact shape commander produces for our option set. Every field is present
 * at parse time because each option either has a default (`fps`, `width`,
 * `height`, `layout`, `verbose`) or is required (`output`). Used only to type
 * the `opts()` cast; commander itself types option values as `any`.
 */
interface RawCliOptions {
  output: string;
  fps: number;
  width: number;
  height: number;
  layout: Layout;
  mode: Mode;
  balls: Balls;
  verbose: boolean;
}

/**
 * Commander option coercion: parse a numeric flag value and reject anything
 * that is not a positive, finite number (e.g. `--fps abc`, `--width 0`).
 *
 * Throwing {@link InvalidArgumentError} lets commander surface a clean,
 * consistent "option ... argument ... is invalid" error rather than silently
 * producing `NaN`.
 */
function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('must be a positive number.');
  }
  return parsed;
}

/**
 * Detect whether an input path is a MIDI or audio file from its extension
 * (Requirement 1.1). Matching is case-insensitive.
 *
 * @throws {InputError} if the extension is missing or not a supported format.
 */
export function detectInputType(inputPath: string): InputType {
  const ext = extname(inputPath).toLowerCase();
  if (MIDI_EXTENSIONS.has(ext)) {
    return 'midi';
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return 'audio';
  }
  const supported = [...MIDI_EXTENSIONS, ...AUDIO_EXTENSIONS].join(', ');
  throw new InputError(
    `Unsupported input file type "${ext || '(no extension)'}" for ${inputPath}. ` +
      `Supported extensions: ${supported}.`,
    { filePath: inputPath },
  );
}

/**
 * Verify the input file exists and is readable before the pipeline runs
 * (Requirement 1.2). Resolves when the file is readable.
 *
 * @throws {InputError} if the path does not exist or cannot be read. The error
 *   message includes the offending path.
 */
export async function assertInputReadable(inputPath: string): Promise<void> {
  try {
    await access(inputPath, constants.R_OK);
  } catch (cause) {
    throw new InputError(`Input file does not exist or is not readable: ${inputPath}`, {
      filePath: inputPath,
      cause,
    });
  }
}

/**
 * Build the commander program describing the MotionScore CLI surface: the
 * `<input>` positional, the required `-o, --output`, and the optional
 * `--fps`/`--width`/`--height`/`--layout`/`--verbose` flags with their defaults
 * (Requirement 1.4).
 *
 * Exported so the main entry (task 9.3) can reuse the exact same definition —
 * e.g. to let commander render `--help` — without duplicating the flag list.
 * This function does not parse or configure error handling; {@link parseArgs}
 * layers that on top.
 */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('motionscore')
    .description('Generate a physics-synced video from a MIDI or audio file.')
    .argument(
      '<input>',
      'path to the input file (MIDI: .mid/.midi, audio: .wav/.mp3/.flac/.ogg)',
    )
    .requiredOption('-o, --output <path>', 'path to the output video file')
    .option('--fps <number>', 'target frame rate', parsePositiveNumber, DEFAULT_FPS)
    .option('--width <number>', 'video width in pixels', parsePositiveNumber, DEFAULT_WIDTH)
    .option('--height <number>', 'video height in pixels', parsePositiveNumber, DEFAULT_HEIGHT)
    .addOption(
      new Option('--layout <type>', 'target layout strategy')
        .choices(LAYOUTS)
        .default(DEFAULT_LAYOUT),
    )
    .addOption(
      new Option(
        '--mode <mode>',
        'what the ball hits (audio only): auto (smart stem-aware attacks), ' +
          'beats (metrical pulse), onsets (all full-mix attacks), stems (neural ' +
          'per-instrument separation, needs PyTorch+Demucs), or notes (full transcription)',
      )
        .choices(MODES)
        .default(DEFAULT_MODE),
    )
    .addOption(
      new Option(
        '--balls <mode>',
        'how many balls to render (audio only): single (one ball hits ' +
          'everything) or per-role (one ball per instrument role)',
      )
        .choices(BALLS)
        .default(DEFAULT_BALLS),
    )
    .option('--verbose', 'print progress information for each pipeline stage', false);
  return program;
}

/**
 * Parse command-line arguments into normalized {@link CLIOptions} plus the
 * detected {@link InputType}.
 *
 * `argv` must be the user-supplied arguments only — i.e. `process.argv.slice(2)`
 * — not the full `process.argv` (there is no executable/script prefix to strip).
 *
 * Error surface (kept pure — this function never calls `process.exit`):
 * - Invalid usage (missing `<input>`, missing `-o`, bad numeric value, invalid
 *   `--layout` choice, or `--help`/`--version`) throws a commander
 *   `CommanderError`. `exitOverride()` converts commander's would-be exit into a
 *   throw, and commander's own stderr output is suppressed so the caller can
 *   format the message from `error.message` without duplication. Help text
 *   (stdout) is left intact so the 9.3 main entry can still print `--help`.
 * - An unsupported input extension throws {@link InputError} (from
 *   {@link detectInputType}).
 *
 * File existence is intentionally NOT checked here — call
 * {@link assertInputReadable} separately (it performs async I/O) so this parse
 * step stays synchronous and hermetic.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const program = buildProgram();
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},
  });

  program.parse(argv, { from: 'user' });

  const opts = program.opts<RawCliOptions>();

  const inputArg: unknown = program.processedArgs[0];
  if (typeof inputArg !== 'string' || inputArg.length === 0) {
    // Unreachable in practice: commander enforces the required `<input>`
    // positional before returning. Guard anyway since `processedArgs` is typed
    // `any[]`, keeping this function honest without an unchecked cast.
    throw new InputError('No input file was provided.');
  }

  const inputType = detectInputType(inputArg);

  const options: CLIOptions = {
    input: inputArg,
    output: opts.output,
    fps: opts.fps,
    width: opts.width,
    height: opts.height,
    layout: opts.layout,
    mode: opts.mode,
    balls: opts.balls,
    verbose: opts.verbose,
  };

  return { options, inputType };
}
