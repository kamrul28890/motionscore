// Unit tests for the MotionScore video exporter (task 8.1, Stage F).
//
// These are hermetic, example-based tests (no property tests, per the task
// scope) that never invoke a real ffmpeg encode. They exercise the fail-fast
// pre-flight (Req 6.2) by pointing FFMPEG_PATH at a binary that does not exist,
// so `checkFfmpegAvailable` reports false and `exportVideo` rejects with an
// `ExportError` carrying install instructions — regardless of whether ffmpeg is
// installed on the host. Config validation is checked the same way.
//
// Sources are imported via `.js` specifiers so Vitest runs against the current
// TypeScript rather than a possibly-stale `dist/`.

import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { ExportConfig } from '@motionscore/types';
import { ExportError } from '@motionscore/types';

import { checkFfmpegAvailable, exportVideo } from './export-video.js';

/** A path guaranteed not to be a runnable binary, used to simulate missing ffmpeg. */
const MISSING_BINARY = join(tmpdir(), 'motionscore-no-such-ffmpeg-9f3a2b7c');

// The pre-flight resolves the binary from FFMPEG_PATH; save/restore it so tests
// that override it never leak state into other suites.
const savedFfmpegPath = process.env.FFMPEG_PATH;

afterEach(() => {
  if (savedFfmpegPath === undefined) {
    delete process.env.FFMPEG_PATH;
  } else {
    process.env.FFMPEG_PATH = savedFfmpegPath;
  }
});

function makeConfig(overrides: Partial<ExportConfig> = {}): ExportConfig {
  return {
    frameDir: join(tmpdir(), 'frames'),
    framePattern: 'frame_%05d.png',
    audioPath: join(tmpdir(), 'audio.wav'),
    outputPath: join(tmpdir(), 'out.mp4'),
    fps: 60,
    ...overrides,
  };
}

describe('checkFfmpegAvailable (Req 6.2)', () => {
  it('resolves false when the configured ffmpeg binary does not exist', async () => {
    process.env.FFMPEG_PATH = MISSING_BINARY;
    await expect(checkFfmpegAvailable()).resolves.toBe(false);
  });
});

describe('exportVideo pre-flight (Req 6.2)', () => {
  it('rejects with an ExportError including install instructions when ffmpeg is missing', async () => {
    process.env.FFMPEG_PATH = MISSING_BINARY;
    const error = await exportVideo(makeConfig()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExportError);
    expect((error as ExportError).message).toMatch(/ffmpeg/i);
    // The message must point the user at where to get ffmpeg.
    expect((error as ExportError).message).toContain('https://ffmpeg.org');
  });
});

describe('exportVideo config validation', () => {
  it('rejects with an ExportError for a non-positive fps', async () => {
    await expect(exportVideo(makeConfig({ fps: 0 }))).rejects.toBeInstanceOf(ExportError);
  });

  it('rejects with an ExportError for an empty output path', async () => {
    await expect(exportVideo(makeConfig({ outputPath: '' }))).rejects.toBeInstanceOf(ExportError);
  });
});
