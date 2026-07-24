// Structured error types for the MotionScore pipeline.
//
// Each error is a proper `Error` subclass so `instanceof` checks work and
// stack traces are preserved. Errors carry structured fields (file paths,
// subprocess output, validation context) so callers can report precise,
// actionable diagnostics rather than parsing message strings.

/** Build `ErrorOptions` only when a cause is present, keeping `cause` unset otherwise. */
function errorOptions(cause: unknown): ErrorOptions | undefined {
  return cause === undefined ? undefined : { cause };
}

/** Safely render an arbitrary value for inclusion in an error message. */
function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Thrown when an input file is missing, unreadable, or not a valid
 * MIDI/audio file, or when a MIDI file contains no note events.
 */
export class InputError extends Error {
  /** Path to the offending input file, when known. */
  readonly filePath?: string;

  constructor(message: string, options?: { filePath?: string; cause?: unknown }) {
    super(message, errorOptions(options?.cause));
    this.name = 'InputError';
    this.filePath = options?.filePath;
  }
}

/**
 * Thrown when audio-to-MIDI transcription fails: the Python environment or
 * Basic Pitch is unavailable, or the subprocess exits with a non-zero code.
 */
export class TranscriptionError extends Error {
  /** Captured subprocess stderr, when available. */
  readonly stderr?: string;

  constructor(message: string, options?: { stderr?: string; cause?: unknown }) {
    super(message, errorOptions(options?.cause));
    this.name = 'TranscriptionError';
    this.stderr = options?.stderr;
  }
}

/**
 * Thrown when a data contract fails validation.
 *
 * Carries the `stage` where validation failed, the offending `field`, and the
 * actual `value`, so the pipeline can report exactly what went wrong and where.
 */
export class ValidationError extends Error {
  /** Pipeline stage/boundary where validation failed (e.g. `'Stage B (NoteEvent)'`). */
  readonly stage: string;
  /** Name of the field that failed validation (e.g. `'pitchMidi'`). */
  readonly field: string;
  /** The actual value that failed validation. */
  readonly value: unknown;

  constructor(stage: string, field: string, value: unknown, message?: string) {
    super(
      message ??
        `Validation failed at ${stage}: field "${field}" has invalid value ${formatValue(value)}`,
    );
    this.name = 'ValidationError';
    this.stage = stage;
    this.field = field;
    this.value = value;
  }
}
