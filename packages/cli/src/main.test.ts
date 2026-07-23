// Unit tests for the CLI `main` entry logic (task 9.2).
//
// These cover `main`'s wiring and error surface WITHOUT running the heavy
// render/export stages: argument-parsing outcomes (help, missing option, bad
// extension) and the early pipeline failures (missing file, audio transcription
// failure). Each asserts the returned exit code (Req 1.2) and, for errors, the
// descriptive stderr message. The end-to-end MIDI -> mp4 path is covered
// separately in `pipeline.test.ts` (guarded on ffmpeg availability).
//
// stdout/stderr are stubbed with `mockReturnValue(true)` so the command's own
// output does not pollute the test log; the captured calls are asserted on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from './main.js';

describe('main', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** All text written to stderr during the current test. */
  const stderrText = (): string => stderrSpy.mock.calls.map((call) => String(call[0])).join('');

  it('returns 0 for --help (commander handles it, exit code 0)', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
    // Help text is written to stdout (not stderr), and no error is reported.
    expect(stdoutSpy).toHaveBeenCalled();
  });

  it('returns 1 when the required -o/--output is missing', async () => {
    const code = await main(['song.mid']);
    expect(code).toBe(1);
    expect(stderrText().length).toBeGreaterThan(0);
  });

  it('returns 1 for an unsupported input extension', async () => {
    const code = await main(['notes.txt', '-o', 'out.mp4']);
    expect(code).toBe(1);
    expect(stderrText()).toContain('Unsupported input file type');
  });

  it('returns 1 for a nonexistent input file, naming the path', async () => {
    const missing = join(tmpdir(), 'motionscore-main-missing-8f2a1c9d0e.mid');
    const code = await main([missing, '-o', 'out.mp4']);
    expect(code).toBe(1);
    expect(stderrText()).toContain('does not exist or is not readable');
  });

  it('returns 1 and surfaces Basic Pitch install guidance for audio in notes mode when unavailable', async () => {
    // `--mode notes` forces the Basic Pitch transcription path. Force the
    // Python executable to a bogus name so it fails fast (spawn ENOENT)
    // regardless of what is installed — hermetic, and proves the notes path
    // reaches transcription and surfaces its guidance as exit 1.
    const PYTHON_ENV_VAR = 'PYTHON';
    const originalPython = process.env[PYTHON_ENV_VAR];
    process.env[PYTHON_ENV_VAR] = 'motionscore-nonexistent-python-executable-7d6e5f';
    const dir = await mkdtemp(join(tmpdir(), 'motionscore-main-'));
    try {
      const wav = join(dir, 'song.wav');
      // Contents are irrelevant: analysis fails before any decode.
      await writeFile(wav, 'placeholder: readability check only, not decoded');
      const code = await main([wav, '-o', join(dir, 'out.mp4'), '--mode', 'notes']);
      expect(code).toBe(1);
      // The failure is a transcription error carrying Basic Pitch install guidance.
      expect(stderrText()).toContain('pip install basic-pitch');
    } finally {
      if (originalPython === undefined) {
        delete process.env[PYTHON_ENV_VAR];
      } else {
        process.env[PYTHON_ENV_VAR] = originalPython;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns 1 with setup guidance for audio in the default smart mode when the analyzer is unavailable', async () => {
    // With no --mode, audio defaults to the librosa smart analyzer. A bogus
    // Python makes it fail fast (ENOENT); the error should point at the
    // lightweight analysis setup rather than Basic Pitch, confirming the
    // default routes to smart analysis (not transcription).
    const PYTHON_ENV_VAR = 'PYTHON';
    const originalPython = process.env[PYTHON_ENV_VAR];
    process.env[PYTHON_ENV_VAR] = 'motionscore-nonexistent-python-executable-7d6e5f';
    const dir = await mkdtemp(join(tmpdir(), 'motionscore-main-'));
    try {
      const wav = join(dir, 'song.wav');
      await writeFile(wav, 'placeholder: readability check only, not decoded');
      const code = await main([wav, '-o', join(dir, 'out.mp4')]);
      expect(code).toBe(1);
      expect(stderrText()).toContain('setup-audio');
    } finally {
      if (originalPython === undefined) {
        delete process.env[PYTHON_ENV_VAR];
      } else {
        process.env[PYTHON_ENV_VAR] = originalPython;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
