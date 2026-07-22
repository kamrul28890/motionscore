// End-to-end pipeline test for the CLI (task 9.2).
//
// Builds a tiny in-memory MIDI (3 short, well-spaced notes) and runs the entire
// `runPipeline` chain — extract -> map -> solve -> render -> export — producing a
// real MP4 in a temp directory, then cleans up. It exercises the M1 keystone:
// `motionscore song.mid -o out.mp4` end to end, including the MIDI-without-audio
// video-only export path.
//
// It is intentionally small (low fps, small canvas, 3 notes) so it renders only
// a handful of frames and finishes quickly. Video export needs a real ffmpeg
// binary, so the test skips cleanly (via `checkFfmpegAvailable`) where ffmpeg is
// not installed, keeping the suite green in minimal environments.
//
// @tonejs/midi is a CommonJS bundle under ESM: a *default* import exposes the
// module object and `Midi` is read from it (mirrors the note-extractor).

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import midiModule from '@tonejs/midi';

import { checkFfmpegAvailable } from '@motionscore/video-export';

import { runPipeline } from './pipeline.js';
import type { ParsedArgs } from './args.js';

const { Midi } = midiModule;

/** Build a tiny 3-note phrase as an in-memory MIDI byte array. */
function buildTinyMidi() {
  const midi = new Midi();
  const track = midi.addTrack();
  track.name = 'melody';
  // Short, well-spaced, in-range notes: each is comfortably reachable so the
  // solver hits all three, and the last impact at 0.8s keeps the frame count low.
  track.addNote({ midi: 60, time: 0.2, duration: 0.15, velocity: 0.7 });
  track.addNote({ midi: 64, time: 0.5, duration: 0.15, velocity: 0.8 });
  track.addNote({ midi: 67, time: 0.8, duration: 0.15, velocity: 0.9 });
  return midi.toArray();
}

describe('runPipeline end-to-end (MIDI -> mp4)', () => {
  let tempDir: string | undefined;

  afterAll(async () => {
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it(
    'renders and exports a playable, video-only mp4 from a tiny MIDI',
    async () => {
      if (!(await checkFfmpegAvailable())) {
        // ffmpeg is required to mux frames into an mp4; skip where unavailable.
        return;
      }

      tempDir = await mkdtemp(join(tmpdir(), 'motionscore-cli-e2e-'));
      const midiPath = join(tempDir, 'tiny.mid');
      const outPath = join(tempDir, 'out.mp4');
      await writeFile(midiPath, Buffer.from(buildTinyMidi()));

      // Small + low-fps so the render is fast (a handful of frames).
      const parsed: ParsedArgs = {
        inputType: 'midi',
        options: {
          input: midiPath,
          output: outPath,
          fps: 24,
          width: 320,
          height: 240,
          layout: 'piano-keys',
          verbose: false,
        },
      };

      const result = await runPipeline(parsed);

      // Output path and stats reflect the run.
      expect(result.outputPath).toBe(outPath);
      expect(result.stats.totalNotes).toBe(3);
      expect(result.stats.renderedFrames).toBeGreaterThan(0);
      // The solver lands impacts exactly, so observed sync error is ~0ms.
      expect(result.stats.maxSyncErrorMs).toBeLessThanOrEqual(15);
      expect(result.stats.durationSec).toBeGreaterThan(0);

      // A non-empty mp4 file was written.
      const info = await stat(outPath);
      expect(info.isFile()).toBe(true);
      expect(info.size).toBeGreaterThan(0);

      // The temporary frame directory was cleaned up: only the midi + mp4 remain.
      const remaining = await readdir(tempDir);
      expect(remaining.sort()).toEqual(['out.mp4', 'tiny.mid']);
    },
    60_000,
  );
});
