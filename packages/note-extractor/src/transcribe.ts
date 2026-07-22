// @motionscore/note-extractor — audio transcription (task 11.1)
//
// M2 audio input: transcribe an audio file to MIDI by invoking Spotify's
// Basic Pitch as a subprocess. This module implements ONLY the subprocess
// wrapper. Routing audio inputs through this wrapper and then through
// `parseMidi` (plus temp-file cleanup) is task 11.2.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { TranscriptionError } from '@motionscore/types';

/**
 * Environment variable that overrides the Python executable used to locate
 * Basic Pitch. When set (e.g. to a venv Python), the `basic-pitch` console
 * script is resolved from the same directory. Defaults to `python`.
 */
const PYTHON_ENV_VAR = 'PYTHON';

/** Python executable used when `process.env.PYTHON` is unset. */
const DEFAULT_PYTHON = 'python';

/** Actionable install guidance surfaced on every transcription failure. */
const INSTALL_INSTRUCTIONS =
  'Audio transcription requires Python 3 and the Basic Pitch package. ' +
  'Install Python 3.x from https://www.python.org, then run ' +
  '`pip install basic-pitch`. If Python is installed under a different name, ' +
  'set the PYTHON environment variable to its path (for example PYTHON=python3).';

/** File extensions Basic Pitch may use for the transcribed MIDI output. */
const MIDI_EXTENSIONS = ['.mid', '.midi'] as const;

/** Suffix Basic Pitch appends to the input stem for its MIDI output file. */
const BASIC_PITCH_MIDI_SUFFIX = '_basic_pitch.mid';

/** True when `name` looks like a MIDI file by extension (case-insensitive). */
function isMidiFile(name: string): boolean {
  const lower = name.toLowerCase();
  return MIDI_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Transcribe an audio file to MIDI using Basic Pitch, returning the absolute
 * path to the generated MIDI file.
 *
 * Basic Pitch is invoked as `python -m basic_pitch <outputDir> <audioPath>`
 * (Requirement 7.1). The MIDI is written into a fresh temp directory; Basic
 * Pitch names it `<inputStem>_basic_pitch.mid`, so after the process exits we
 * scan the directory and return that file's path (preferring the canonical
 * `_basic_pitch.mid` name, falling back to any `.mid`/`.midi`).
 *
 * The Python executable can be overridden with the `PYTHON` environment
 * variable (defaults to `python`) to support venvs and `python3`/`py` setups.
 *
 * SECURITY: the subprocess is spawned with an argument array and no shell
 * (`shell: false`), so `outputDir` and `audioPath` are passed as individual
 * argv entries and are never interpolated into a shell command line (design
 * "Security Considerations": no shell interpolation for subprocess invocation).
 *
 * CLEANUP: on success the returned MIDI lives in a temp directory that this
 * function does NOT delete — the caller owns it and must remove it after
 * parsing (task 11.2). On failure the temp directory is removed best-effort.
 *
 * @param audioPath Path to the source audio file (WAV/MP3/FLAC/OGG).
 * @returns Absolute path to the generated MIDI file.
 * @throws TranscriptionError if Python/Basic Pitch is unavailable (spawn
 *   `ENOENT`), the subprocess exits non-zero (captured stderr is attached and
 *   summarized — Requirement 7.4), or the process succeeds but emits no MIDI.
 */
export async function transcribeAudio(audioPath: string): Promise<string> {
  const python = process.env[PYTHON_ENV_VAR] ?? DEFAULT_PYTHON;
  const outputDir = await mkdtemp(join(tmpdir(), 'motionscore-transcribe-'));

  try {
    await runBasicPitch(python, outputDir, audioPath);
    return await locateGeneratedMidi(outputDir, audioPath);
  } catch (error) {
    // On any failure the caller never receives a path, so clean up the temp
    // directory here (best-effort). The success path deliberately leaves it in
    // place for the caller to consume and then remove.
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Resolve the `basic-pitch` executable. Strategy:
 * 1. If PYTHON points to a venv Python, look for `basic-pitch` (or
 *    `basic-pitch.exe` on Windows) in the same Scripts/bin directory.
 * 2. Otherwise fall back to `python -m basic_pitch` (works when basic-pitch
 *    has a __main__.py, e.g. newer versions).
 *
 * Returns { exe, args } where `exe` is the binary to spawn and `args` is the
 * prefix arguments before `<outputDir> <audioPath>`.
 */
function resolveBasicPitchCommand(python: string): { exe: string; args: string[] } {
  const pythonDir = dirname(python);

  // Look for the console script next to the Python executable
  const candidates = [
    join(pythonDir, 'basic-pitch.exe'),
    join(pythonDir, 'basic-pitch'),
  ];
  const script = candidates.find((p) => existsSync(p));
  if (script) {
    return { exe: script, args: [] };
  }

  // Fallback: python -m basic_pitch (for system installs or newer versions)
  return { exe: python, args: ['-m', 'basic_pitch'] };
}

/**
 * Spawn the Basic Pitch CLI and resolve once it exits 0. Rejects with a
 * `TranscriptionError` if the process cannot be started (e.g. executable
 * missing → `ENOENT`) or exits with a non-zero code, attaching the captured
 * stderr for diagnostics.
 */
function runBasicPitch(python: string, outputDir: string, audioPath: string): Promise<void> {
  const { exe, args } = resolveBasicPitchCommand(python);
  const fullArgs = [...args, outputDir, audioPath];

  return new Promise<void>((resolve, reject) => {
    // Argument array + shell:false → each path is a single argv entry and is
    // never parsed by a shell, preventing command injection via file paths.
    // PYTHONIOENCODING=utf-8 prevents UnicodeEncodeError on Windows when
    // Basic Pitch prints emoji/sparkle characters to stdout (cp1252 can't
    // encode them; utf-8 can).
    const child = spawn(exe, fullArgs, {
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (cause: Error) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        reject(
          new TranscriptionError(
            `Basic Pitch executable not found (tried "${exe}"). ${INSTALL_INSTRUCTIONS}`,
            { cause },
          ),
        );
        return;
      }
      reject(
        new TranscriptionError(
          `Failed to start the Basic Pitch subprocess ("${exe}"): ${cause.message}. ${INSTALL_INSTRUCTIONS}`,
          { cause },
        ),
      );
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      // Prefer stderr for the failure detail; fall back to stdout if empty.
      const captured = stderr.trim().length > 0 ? stderr.trim() : stdout.trim();
      reject(
        new TranscriptionError(
          `Basic Pitch exited with code ${code ?? 'null'} while transcribing "${audioPath}". ` +
            `${INSTALL_INSTRUCTIONS}` +
            (captured.length > 0 ? `\n--- Basic Pitch output ---\n${captured}` : ''),
          captured.length > 0 ? { stderr: captured } : undefined,
        ),
      );
    });
  });
}

/**
 * Locate the MIDI file Basic Pitch wrote into `outputDir`. Prefers the
 * canonical `<stem>_basic_pitch.mid` output; otherwise returns the first
 * `.mid`/`.midi` found. Throws if the directory contains no MIDI file despite
 * a successful exit.
 */
async function locateGeneratedMidi(outputDir: string, audioPath: string): Promise<string> {
  const entries = await readdir(outputDir);
  const midiFiles = entries.filter(isMidiFile);
  const chosen =
    midiFiles.find((name) => name.toLowerCase().endsWith(BASIC_PITCH_MIDI_SUFFIX)) ??
    midiFiles[0];

  if (chosen === undefined) {
    throw new TranscriptionError(
      `Basic Pitch reported success but produced no MIDI output for "${audioPath}". ${INSTALL_INSTRUCTIONS}`,
    );
  }

  return join(outputDir, chosen);
}
