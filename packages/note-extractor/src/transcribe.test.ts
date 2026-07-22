// Tests for the Basic Pitch subprocess wrapper (task 11.1).
//
// These tests are hermetic: they do NOT require Basic Pitch (or any working
// Python) to be installed. They exercise the two error paths from Requirement 7
// deterministically by overriding the Python executable via the PYTHON env var:
//
//   - Missing Python (spawn ENOENT)  → Requirement 7.3
//   - Non-zero subprocess exit + stderr capture → Requirement 7.4
//
// The non-zero-exit case points PYTHON at the Node binary (always present in
// the test runtime). The wrapper always passes `-m basic_pitch ...`; Node
// rejects `-m` with a non-zero exit code and a stderr message, which is exactly
// the failure shape we need — no Python packages required.
//
// Sources are imported from `./transcribe.js` so tests run against the current
// TypeScript rather than a possibly-stale `dist/`.

import { describe, it, expect, afterEach } from 'vitest';
import { TranscriptionError } from '@motionscore/types';

import { transcribeAudio } from './transcribe.js';

const PYTHON_ENV_VAR = 'PYTHON';

/** Restore whatever PYTHON override was present before each test mutated it. */
const originalPython = process.env[PYTHON_ENV_VAR];
afterEach(() => {
  if (originalPython === undefined) {
    delete process.env[PYTHON_ENV_VAR];
  } else {
    process.env[PYTHON_ENV_VAR] = originalPython;
  }
});

/** Run `transcribeAudio` and return the thrown error (fails if it resolves). */
async function captureError(audioPath: string): Promise<unknown> {
  try {
    await transcribeAudio(audioPath);
  } catch (error) {
    return error;
  }
  throw new Error('expected transcribeAudio to reject, but it resolved');
}

describe('transcribeAudio — missing Python (Requirement 7.3)', () => {
  it('rejects with a TranscriptionError that includes install instructions', async () => {
    // A path that cannot resolve to any real executable → spawn emits ENOENT.
    process.env[PYTHON_ENV_VAR] = 'motionscore-nonexistent-python-executable-9f8a7b6c';

    const error = await captureError('some-audio.wav');

    expect(error).toBeInstanceOf(TranscriptionError);
    const message = (error as TranscriptionError).message;
    expect(message.toLowerCase()).toContain('python');
    // Install guidance for the Basic Pitch package must be surfaced.
    expect(message).toContain('pip install basic-pitch');
    // The underlying spawn error is preserved as the cause.
    expect((error as TranscriptionError).cause).toBeInstanceOf(Error);
  });
});

describe('transcribeAudio — non-zero subprocess exit (Requirement 7.4)', () => {
  it('rejects with a TranscriptionError carrying the captured stderr', async () => {
    // Point PYTHON at the Node binary. The wrapper invokes it with
    // `-m basic_pitch ...`; Node does not accept `-m`, so it exits non-zero and
    // writes a diagnostic to stderr — deterministic, no Python packages needed.
    process.env[PYTHON_ENV_VAR] = process.execPath;

    const error = await captureError('some-audio.wav');

    expect(error).toBeInstanceOf(TranscriptionError);
    const transcriptionError = error as TranscriptionError;
    // stderr from the failing subprocess is captured and attached (Req 7.4).
    expect(typeof transcriptionError.stderr).toBe('string');
    expect((transcriptionError.stderr ?? '').length).toBeGreaterThan(0);
    // The message reports a non-zero exit and still includes install guidance.
    expect(transcriptionError.message).toContain('exited with code');
    expect(transcriptionError.message).toContain('pip install basic-pitch');
  });
});
