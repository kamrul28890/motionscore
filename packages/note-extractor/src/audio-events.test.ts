// Tests for the librosa beat/onset extractor (audio-events.ts).
//
// Two halves, mirroring the transcription integration test's approach so the
// suite stays green everywhere:
//
//   1. Error handling (ALWAYS runs). Pointing PYTHON at a bogus executable
//      makes the subprocess fail with ENOENT on every host, proving
//      `extractAudioEvents` surfaces a TranscriptionError that points at the
//      venv setup (distinct from the Basic Pitch guidance).
//
//   2. Happy path (CONDITIONAL). Only runs when librosa is importable (probed
//      at startup); otherwise skipped with a log line. When it runs, it drives
//      the real analysis on a synthesized rhythmic click track and checks the
//      returned events are sparse, valid, and strictly time-ordered.
//
// Sources are imported from `./audio-events.js` so tests run against the
// current TypeScript rather than a possibly-stale `dist/`.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptionError } from '@motionscore/types';

import { extractAudioEvents } from './audio-events.js';

const PYTHON_ENV_VAR = 'PYTHON';
const DEFAULT_PYTHON = 'python';
const BOGUS_PYTHON = 'motionscore-nonexistent-python-executable-b8e7f6';

const WAV_HEADER_BYTES = 44;
const INT16_MAX = 32767;

/**
 * Synthesize a mono 16-bit PCM WAV containing short percussive clicks at a
 * fixed tempo, so librosa's beat/onset detectors have clear events to find.
 */
function generateClickWav(bpm: number, durationSec: number, sampleRate = 22050): Buffer {
  const numSamples = Math.floor(durationSec * sampleRate);
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(WAV_HEADER_BYTES + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  const beatPeriodSec = 60 / bpm;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const phase = t % beatPeriodSec;
    // Sharp exponentially-decaying click at each beat (a broadband transient).
    const env = phase < 0.05 ? Math.exp(-phase * 60) : 0;
    const tone = Math.sin(2 * Math.PI * 200 * t);
    const sample = Math.round(tone * env * 0.8 * INT16_MAX);
    buffer.writeInt16LE(Math.max(-32768, Math.min(INT16_MAX, sample)), WAV_HEADER_BYTES + i * 2);
  }
  return buffer;
}

/** Probe whether librosa can be imported by the configured Python (fast). */
function detectLibrosa(): Promise<boolean> {
  return new Promise((resolve) => {
    const python = process.env[PYTHON_ENV_VAR] ?? DEFAULT_PYTHON;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(python, ['-c', 'import librosa'], { shell: false });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, 60_000);
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

let workDir: string;
let clickWavPath: string;
let librosaAvailable = false;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'motionscore-beats-it-'));
  clickWavPath = join(workDir, 'clicks-120bpm.wav');
  // 120 BPM over 3s → ~6 beats; short so real analysis stays fast if it runs.
  await writeFile(clickWavPath, generateClickWav(120, 3));
  librosaAvailable = await detectLibrosa();
  console.log(
    librosaAvailable
      ? '[audio-events] librosa detected — running beat/onset happy-path assertions.'
      : '[audio-events] librosa NOT available — happy-path assertions skipped (error tests still run).',
  );
}, 90_000);

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

describe('extractAudioEvents — error handling', () => {
  const originalPython = process.env[PYTHON_ENV_VAR];
  afterEach(() => {
    if (originalPython === undefined) {
      delete process.env[PYTHON_ENV_VAR];
    } else {
      process.env[PYTHON_ENV_VAR] = originalPython;
    }
  });

  it('rejects with a TranscriptionError pointing at the venv setup when Python is missing', async () => {
    process.env[PYTHON_ENV_VAR] = BOGUS_PYTHON;

    let caught: unknown;
    try {
      await extractAudioEvents('does-not-exist.wav', 'beats');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TranscriptionError);
    const message = (caught as TranscriptionError).message;
    expect(message.toLowerCase()).toContain('python');
    // Distinct from the Basic Pitch guidance: points at the setup script.
    expect(message).toContain('setup-audio');
  });
});

describe('extractAudioEvents — beat/onset analysis (requires librosa)', () => {
  it(
    'returns a sparse, valid, strictly-ordered NoteEvent[] for a click track (beats)',
    async () => {
      if (!librosaAvailable) {
        console.log('[skip] librosa not available — skipping beat analysis happy path.');
        return;
      }

      const events = await extractAudioEvents(clickWavPath, 'beats');

      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);
      // A 3s clip must yield far fewer events than a per-note transcription would.
      expect(events.length).toBeLessThan(30);

      const seenIds = new Set<string>();
      let previousStart = Number.NEGATIVE_INFINITY;
      for (const event of events) {
        expect(seenIds.has(event.id)).toBe(false);
        seenIds.add(event.id);

        expect(Number.isInteger(event.pitchMidi)).toBe(true);
        expect(event.pitchMidi).toBeGreaterThanOrEqual(21);
        expect(event.pitchMidi).toBeLessThanOrEqual(108);

        expect(event.velocity).toBeGreaterThanOrEqual(0.1);
        expect(event.velocity).toBeLessThanOrEqual(1);

        expect(event.startSec).toBeGreaterThanOrEqual(0);
        expect(event.endSec).toBeGreaterThan(event.startSec);

        // Strictly increasing, and never closer than the min-gap thinning.
        expect(event.startSec).toBeGreaterThan(previousStart);
        previousStart = event.startSec;
      }
    },
    90_000,
  );
});
