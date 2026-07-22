// Property-based tests for the MIDI note extractor (task 2.2).
//
// Covers two design correctness properties:
//   - Property 11 (MIDI velocity normalization) — Requirement 2.3
//   - Property 10 (Note id uniqueness)          — Requirement 2.5
//
// Property 11 exercises the pure `normalizeVelocity` helper directly. Property
// 10 drives the full `parseMidi` path by synthesizing valid MIDI files in
// memory (via @tonejs/midi's write API), writing them to a temp directory, and
// parsing them back. Sources are imported from `./index.js` so tests run
// against the current TypeScript, not a possibly-stale `dist/`.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @tonejs/midi is a CommonJS bundle; Node's ESM loader exposes module.exports
// as the default, so `Midi` must be read from the default import (a named
// import would be undefined at runtime).
import midiModule from '@tonejs/midi';

import { normalizeVelocity, parseMidi } from './index.js';

const { Midi } = midiModule;

/** MIDI velocity is an integer in [0, 127]; normalization divides by this. */
const MIDI_VELOCITY_MAX = 127;

describe('normalizeVelocity — Property 11: MIDI velocity normalization', () => {
  // **Validates: Requirements 2.3**
  it('maps any MIDI velocity in [0,127] to value/127 within [0.0, 1.0]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MIDI_VELOCITY_MAX }), (midiVelocity) => {
        const normalized = normalizeVelocity(midiVelocity);
        // Output stays within the normalized range.
        expect(normalized).toBeGreaterThanOrEqual(0);
        expect(normalized).toBeLessThanOrEqual(1);
        // Output is exactly the linear normalization value/127.
        expect(normalized).toBe(midiVelocity / MIDI_VELOCITY_MAX);
      }),
    );
  });

  it('maps boundary and midpoint velocities exactly', () => {
    expect(normalizeVelocity(0)).toBe(0);
    expect(normalizeVelocity(MIDI_VELOCITY_MAX)).toBe(1);
    expect(normalizeVelocity(64)).toBe(64 / MIDI_VELOCITY_MAX);
  });
});

/** A single synthesizable MIDI note with valid, round-trippable fields. */
interface NoteSpec {
  pitchMidi: number;
  startSec: number;
  durationSec: number;
  rawVelocity: number;
}

/**
 * Generator for a non-empty set of valid MIDI notes.
 *
 * - `pitchMidi` spans the full MIDI range [0, 127].
 * - `startSec` is non-negative; `durationSec` is comfortably above the tick
 *   quantization floor (~1ms at ppq 480 / 120bpm) so no note collapses to a
 *   zero-length event and disappears on the round-trip.
 * - `rawVelocity` is >= 1: a MIDI note-on with velocity 0 is interpreted as a
 *   note-off, so it would never produce a NoteEvent.
 */
const noteSpecArb: fc.Arbitrary<NoteSpec> = fc.record({
  pitchMidi: fc.integer({ min: 0, max: MIDI_VELOCITY_MAX }),
  startSec: fc.double({ min: 0, max: 30, noNaN: true }),
  durationSec: fc.double({ min: 0.05, max: 2, noNaN: true }),
  rawVelocity: fc.integer({ min: 1, max: MIDI_VELOCITY_MAX }),
});

const noteSpecsArb: fc.Arbitrary<NoteSpec[]> = fc.array(noteSpecArb, {
  minLength: 1,
  maxLength: 8,
});

/**
 * Build an in-memory MIDI file from the given note specs and return the encoded
 * bytes. Each note is placed on its own track so that overlapping notes of the
 * same pitch never collide during note-on/note-off pairing — every spec yields
 * exactly one parsed NoteEvent, which also exercises id uniqueness *across*
 * tracks (the interesting case for Property 10).
 */
function buildMidiBytes(specs: readonly NoteSpec[]): Uint8Array {
  const midi = new Midi();
  for (const spec of specs) {
    const track = midi.addTrack();
    track.addNote({
      midi: spec.pitchMidi,
      time: spec.startSec,
      duration: spec.durationSec,
      velocity: spec.rawVelocity / MIDI_VELOCITY_MAX,
    });
  }
  return midi.toArray();
}

describe('parseMidi — Property 10: note id uniqueness', () => {
  // **Validates: Requirements 2.5**
  it('assigns mutually unique ids to every parsed note', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motionscore-midi-'));
    let fileCounter = 0;
    try {
      await fc.assert(
        fc.asyncProperty(noteSpecsArb, async (specs) => {
          const filePath = join(dir, `notes-${fileCounter++}.mid`);
          await writeFile(filePath, buildMidiBytes(specs));

          const events = await parseMidi(filePath);
          const ids = events.map((event) => event.id);

          // Core property: no two NoteEvents share an id.
          expect(new Set(ids).size).toBe(ids.length);
          // Sanity: every synthesized note round-trips to exactly one event, so
          // uniqueness is being checked against the full, non-empty output.
          expect(events.length).toBe(specs.length);
        }),
        { numRuns: 30 },
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
