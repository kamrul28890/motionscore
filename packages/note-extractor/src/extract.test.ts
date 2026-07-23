// Tests for the format-routing note extractor `extract`.
//
// `extract` is the top-level Stage B entry point. It routes by file extension
// and, for audio, by extraction `mode`:
//   - MIDI (.mid/.midi) → parsed directly via parseMidi (mode ignored)
//   - audio (.wav/.mp3/.flac/.ogg):
//       * 'beats' / 'onsets' (and 'auto', the default → smart) → librosa
//         rhythmic analysis (analyzeAudioEvents)
//       * 'notes' → full Basic Pitch transcription → parseMidi
//   - anything else → InputError listing supported formats
// and validates the resulting NoteEvents against the shared data contract so
// every path is held to the same guarantees as direct MIDI (Req 7.5).
//
// These tests are HERMETIC — they do NOT require librosa or Basic Pitch to be
// installed:
//   - The MIDI path is exercised with an in-memory MIDI file synthesized via
//     @tonejs/midi's write API (mirrors index.test.ts).
//   - Each audio branch's wiring is confirmed by pointing the PYTHON env var at
//     a bogus executable so the subprocess fails fast with ENOENT; `extract`
//     must surface that as a TranscriptionError. The DISTINCT error guidance of
//     each branch (Basic Pitch vs. the librosa setup script) proves `notes`
//     routes to transcription while the default routes to smart analysis.
//
// Sources are imported from `./index.js` so tests run against the current
// TypeScript, not a possibly-stale `dist/`.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @tonejs/midi is a CommonJS bundle; Node's ESM loader exposes module.exports
// as the default, so `Midi` must be read from the default import.
import midiModule from '@tonejs/midi';
import { InputError, TranscriptionError } from '@motionscore/types';

import { extract, type ExtractOptions } from './index.js';

const { Midi } = midiModule;

/** MIDI velocity is an integer in [0, 127]; @tonejs/midi wants it normalized. */
const MIDI_VELOCITY_MAX = 127;

/** Env var that overrides the Python executable used by transcribeAudio. */
const PYTHON_ENV_VAR = 'PYTHON';

/**
 * Build a tiny, valid 3-note MIDI file (distinct pitches, non-overlapping) as
 * an in-memory byte array. Each note round-trips to exactly one NoteEvent.
 */
function buildMidiBytes(): Uint8Array {
  const midi = new Midi();
  const track = midi.addTrack();
  track.name = 'melody';
  track.addNote({ midi: 60, time: 0, duration: 0.4, velocity: 100 / MIDI_VELOCITY_MAX });
  track.addNote({ midi: 64, time: 0.5, duration: 0.4, velocity: 80 / MIDI_VELOCITY_MAX });
  track.addNote({ midi: 67, time: 1.0, duration: 0.4, velocity: 90 / MIDI_VELOCITY_MAX });
  return midi.toArray();
}

/** Run `extract` and return the thrown error (fails if it resolves instead). */
async function captureError(inputPath: string, options?: ExtractOptions): Promise<unknown> {
  try {
    await extract(inputPath, options);
  } catch (error) {
    return error;
  }
  throw new Error('expected extract to reject, but it resolved');
}

describe('extract — MIDI routing (Requirements 7.2, 7.5)', () => {
  it('routes a .mid file through parseMidi and returns valid NoteEvents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motionscore-extract-'));
    try {
      const filePath = join(dir, 'song.mid');
      await writeFile(filePath, buildMidiBytes());

      const notes = await extract(filePath);

      // All three synthesized notes round-trip to NoteEvents.
      expect(notes.length).toBe(3);

      // The contract validateNoteEvents enforces holds on the output:
      // unique non-empty ids, normalized velocity, ascending valid timing.
      const ids = notes.map((note) => note.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const note of notes) {
        expect(note.id.length).toBeGreaterThan(0);
        expect(note.velocity).toBeGreaterThanOrEqual(0);
        expect(note.velocity).toBeLessThanOrEqual(1);
        expect(note.endSec).toBeGreaterThan(note.startSec);
        expect(note.pitchMidi).toBeGreaterThanOrEqual(0);
        expect(note.pitchMidi).toBeLessThanOrEqual(MIDI_VELOCITY_MAX);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('routes case-insensitively (.MID uppercase extension)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motionscore-extract-'));
    try {
      const filePath = join(dir, 'SONG.MID');
      await writeFile(filePath, buildMidiBytes());

      const notes = await extract(filePath);
      expect(notes.length).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('extract — unsupported extension', () => {
  it('throws InputError listing the supported formats', async () => {
    const error = await captureError('notes.txt');

    expect(error).toBeInstanceOf(InputError);
    const message = (error as InputError).message;
    // Reports the offending extension and the full supported set.
    expect(message).toContain('.txt');
    expect(message).toContain('.mid');
    expect(message).toContain('.midi');
    expect(message).toContain('.wav');
    expect(message).toContain('.mp3');
    expect(message).toContain('.flac');
    expect(message).toContain('.ogg');
    expect((error as InputError).filePath).toBe('notes.txt');
  });
});

describe('extract — audio routing (Requirements 7.1, 7.3)', () => {
  // A path that cannot resolve to any real executable → spawn emits ENOENT, so
  // the subprocess fails fast without needing librosa or Basic Pitch installed.
  const BOGUS_PYTHON = 'motionscore-nonexistent-python-executable-3a2b1c';

  // Restore whatever PYTHON override existed before each test mutated it.
  const originalPython = process.env[PYTHON_ENV_VAR];
  afterEach(() => {
    if (originalPython === undefined) {
      delete process.env[PYTHON_ENV_VAR];
    } else {
      process.env[PYTHON_ENV_VAR] = originalPython;
    }
  });

  it('routes notes mode to Basic Pitch and surfaces its install guidance when unavailable', async () => {
    process.env[PYTHON_ENV_VAR] = BOGUS_PYTHON;

    const error = await captureError('foo.wav', { mode: 'notes' });

    expect(error).toBeInstanceOf(TranscriptionError);
    // The transcription path points the user at the Basic Pitch package (Req 7.3).
    expect((error as TranscriptionError).message).toContain('pip install basic-pitch');
  });

  it('routes beats mode to the librosa analyzer and surfaces its setup guidance when unavailable', async () => {
    process.env[PYTHON_ENV_VAR] = BOGUS_PYTHON;

    const error = await captureError('foo.wav', { mode: 'beats' });

    expect(error).toBeInstanceOf(TranscriptionError);
    const message = (error as TranscriptionError).message;
    // The rhythmic path points the user at the venv setup script (distinct from
    // the Basic Pitch guidance), proving beats routes to librosa, not transcription.
    expect(message.toLowerCase()).toContain('python');
    expect(message).toContain('setup-audio');
  });

  it('defaults audio input to the smart analyzer (not full transcription)', async () => {
    process.env[PYTHON_ENV_VAR] = BOGUS_PYTHON;

    // No mode supplied → 'auto' → smart for audio. The lightweight librosa
    // setup guidance (not Basic Pitch guidance) confirms the analyzer branch.
    const error = await captureError('foo.wav');

    expect(error).toBeInstanceOf(TranscriptionError);
    expect((error as TranscriptionError).message).toContain('setup-audio');
  });
});
