// Unit tests for the CLI argument parser (task 9.1).
//
// Covers the three responsibilities of this task:
//   - parseArgs: argument/flag parsing, defaults, numeric coercion, and the
//     error surface (commander CommanderError on bad usage) — Requirements 1.1, 1.4
//   - detectInputType: extension-based MIDI/audio routing, case-insensitive,
//     with InputError on unknown formats — Requirement 1.1
//   - assertInputReadable: existence/readability check — Requirement 1.2
//
// Sources are imported from `./index.js` (the package's public surface) so the
// tests also confirm the re-exports task 9.2 will consume. No real MIDI/audio
// files are needed: detection is extension-only and existence is exercised with
// a throwaway temp file and a guaranteed-missing path.

import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommanderError } from 'commander';

import { InputError } from '@motionscore/types';
import { parseArgs, detectInputType, assertInputReadable } from './index.js';

describe('parseArgs', () => {
  it('parses a minimal invocation (input + -o) with documented defaults', () => {
    const { options, inputType } = parseArgs(['song.mid', '-o', 'out.mp4']);

    expect(options).toEqual({
      input: 'song.mid',
      output: 'out.mp4',
      fps: 60,
      width: 1920,
      height: 1080,
      layout: 'piano-keys',
      mode: 'auto',
      verbose: false,
    });
    expect(inputType).toBe('midi');
  });

  it('parses all optional flags and coerces numeric values to numbers', () => {
    const { options, inputType } = parseArgs([
      'track.wav',
      '--output',
      'result.mp4',
      '--fps',
      '30',
      '--width',
      '1280',
      '--height',
      '720',
      '--layout',
      'lanes',
      '--mode',
      'onsets',
      '--verbose',
    ]);

    expect(options).toEqual({
      input: 'track.wav',
      output: 'result.mp4',
      fps: 30,
      width: 1280,
      height: 720,
      layout: 'lanes',
      mode: 'onsets',
      verbose: true,
    });
    // Numeric flags must be numbers, not the raw argv strings.
    expect(typeof options.fps).toBe('number');
    expect(typeof options.width).toBe('number');
    expect(typeof options.height).toBe('number');
    expect(inputType).toBe('audio');
  });

  it('rejects a non-numeric --fps value', () => {
    expect(() => parseArgs(['song.mid', '-o', 'out.mp4', '--fps', 'abc'])).toThrow(CommanderError);
  });

  it('rejects a non-positive numeric flag', () => {
    expect(() => parseArgs(['song.mid', '-o', 'out.mp4', '--width', '0'])).toThrow(CommanderError);
  });

  it('rejects an invalid --layout choice', () => {
    expect(() => parseArgs(['song.mid', '-o', 'out.mp4', '--layout', 'spiral'])).toThrow(
      CommanderError,
    );
  });

  it('rejects an invalid --mode choice', () => {
    expect(() => parseArgs(['song.mid', '-o', 'out.mp4', '--mode', 'melody'])).toThrow(
      CommanderError,
    );
  });

  it('requires the -o/--output option', () => {
    expect(() => parseArgs(['song.mid'])).toThrow(CommanderError);
  });

  it('rejects an unsupported input extension', () => {
    expect(() => parseArgs(['notes.txt', '-o', 'out.mp4'])).toThrow(InputError);
  });
});

describe('detectInputType', () => {
  it('routes MIDI extensions (case-insensitive)', () => {
    expect(detectInputType('a.mid')).toBe('midi');
    expect(detectInputType('a.midi')).toBe('midi');
    expect(detectInputType('A.MID')).toBe('midi');
    expect(detectInputType('/path/to/B.Midi')).toBe('midi');
  });

  it('routes audio extensions (case-insensitive)', () => {
    for (const path of ['a.wav', 'a.mp3', 'a.flac', 'a.ogg', 'LOUD.WAV']) {
      expect(detectInputType(path)).toBe('audio');
    }
  });

  it('throws InputError on an unknown or missing extension', () => {
    expect(() => detectInputType('a.txt')).toThrow(InputError);
    expect(() => detectInputType('noextension')).toThrow(InputError);
  });
});

describe('assertInputReadable', () => {
  it('resolves for an existing, readable file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motionscore-cli-'));
    try {
      const file = join(dir, 'exists.mid');
      await writeFile(file, 'placeholder: existence check only, not parsed');
      await expect(assertInputReadable(file)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws InputError for a nonexistent path', async () => {
    const missing = join(tmpdir(), 'motionscore-cli-missing-9e3c1a7f0b.mid');
    await expect(assertInputReadable(missing)).rejects.toBeInstanceOf(InputError);
  });
});
