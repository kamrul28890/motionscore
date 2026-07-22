// @motionscore/note-extractor
//
// Stage B: converts MIDI (and, in M2, audio via Basic Pitch) input into a
// normalized NoteEvent[] regardless of source format.
//
// `extract` is the top-level entry point: it routes by file extension, parsing
// MIDI directly (task 2.1) and transcribing audio to MIDI via Basic Pitch
// before parsing it through the same path (task 11.2). Both paths converge on
// `parseMidi` and are validated against the same NoteEvent contract.

import { readFile, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
// Basic Pitch audio-to-MIDI subprocess wrapper (task 11.1). Imported so the
// audio branch of `extract` can transcribe audio to MIDI, and re-exported so
// the note-extractor package surfaces both the MIDI and audio entry points.
import { transcribeAudio } from './transcribe.js';
// `@tonejs/midi` ships as a CommonJS bundle whose named exports Node's ESM
// loader cannot statically detect, so we default-import the module object
// (Node exposes `module.exports` as the default) and read `Midi` from it.
import midiModule from '@tonejs/midi';
import { InputError, validateNoteEvents, type NoteEvent } from '@motionscore/types';

export { transcribeAudio };

const { Midi } = midiModule;

/** Maximum MIDI velocity value; MIDI velocity is an integer in [0, 127]. */
const MIDI_VELOCITY_MAX = 127;

/** Width of the zero-padded numeric portion of a generated note id. */
const NOTE_ID_DIGITS = 4;

/**
 * Input file extensions routed to the direct MIDI parser (lower-cased, leading
 * dot). Kept in sync with the CLI's `detectInputType` (Requirement 1.1).
 */
const MIDI_EXTENSIONS: ReadonlySet<string> = new Set(['.mid', '.midi']);

/**
 * Input file extensions routed to Basic Pitch audio transcription (lower-cased,
 * leading dot). Kept in sync with the CLI's `detectInputType` (Requirement 1.1).
 */
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set(['.wav', '.mp3', '.flac', '.ogg']);

/**
 * Normalize a raw MIDI velocity in [0, 127] to [0.0, 1.0] via linear division.
 *
 * The normalization is exactly `midiVelocity / 127`, preserving proportionality
 * (Requirement 2.3). Callers are responsible for passing an integer velocity in
 * the valid MIDI range.
 */
export function normalizeVelocity(midiVelocity: number): number {
  return midiVelocity / MIDI_VELOCITY_MAX;
}

/**
 * Format a 1-based ordinal as a zero-padded note id, e.g. `1 -> 'n0001'`.
 */
function formatNoteId(ordinal: number): string {
  return `n${String(ordinal).padStart(NOTE_ID_DIGITS, '0')}`;
}

/**
 * A note collected from the MIDI structure before ids are assigned. Timing is
 * already in seconds (converted from ticks via the file's tempo map) and the
 * velocity is the recovered raw MIDI integer in [0, 127].
 */
interface CollectedNote {
  pitchMidi: number;
  startSec: number;
  endSec: number;
  rawVelocity: number;
  track?: string;
}

/**
 * Parse a MIDI file into a normalized, time-sorted `NoteEvent[]`.
 *
 * Behavior (Requirement 2):
 * - Timing is converted from MIDI ticks to seconds using the file's tempo map.
 * - Velocity is normalized from the MIDI range [0, 127] to [0.0, 1.0].
 * - Each event receives a unique, zero-padded id (`n0001`, `n0002`, ...).
 * - Track names are preserved into each event's `track` field when present.
 * - Output is sorted by `startSec` ascending.
 *
 * @throws InputError if the file cannot be read, is malformed, or contains no
 *   note events.
 */
export async function parseMidi(filePath: string): Promise<NoteEvent[]> {
  let raw: Buffer;
  try {
    raw = await readFile(filePath);
  } catch (cause) {
    throw new InputError(`Unable to read MIDI file: ${filePath}`, { filePath, cause });
  }

  let midi: InstanceType<typeof Midi>;
  try {
    midi = new Midi(raw);
  } catch (cause) {
    throw new InputError(`Malformed or unreadable MIDI file: ${filePath}`, {
      filePath,
      cause,
    });
  }

  const collected: CollectedNote[] = [];
  for (const track of midi.tracks) {
    const trackName = track.name.length > 0 ? track.name : undefined;
    for (const note of track.notes) {
      // @tonejs/midi stores velocity normalized as raw/127; recover the exact
      // raw integer so downstream normalization is precisely value/127.
      const rawVelocity = Math.round(note.velocity * MIDI_VELOCITY_MAX);
      const collectedNote: CollectedNote = {
        pitchMidi: note.midi,
        startSec: note.time,
        endSec: note.time + note.duration,
        rawVelocity,
      };
      if (trackName !== undefined) {
        collectedNote.track = trackName;
      }
      collected.push(collectedNote);
    }
  }

  if (collected.length === 0) {
    throw new InputError(`MIDI file contains no note events: ${filePath}`, { filePath });
  }

  // Sort chronologically before assigning ids so that ids ascend with onset
  // time (parseMidi postcondition: events sorted by startSec).
  collected.sort((a, b) => a.startSec - b.startSec);

  return collected.map((note, index) => {
    const event: NoteEvent = {
      id: formatNoteId(index + 1),
      pitchMidi: note.pitchMidi,
      startSec: note.startSec,
      endSec: note.endSec,
      velocity: normalizeVelocity(note.rawVelocity),
    };
    if (note.track !== undefined) {
      event.track = note.track;
    }
    return event;
  });
}

/**
 * Extract a normalized `NoteEvent[]` from any supported input file, routing by
 * file extension (case-insensitive) — the package's top-level Stage B entry
 * point (design "Component 2: Note Extractor", `NoteExtractor.extract`).
 *
 * Routing (Requirements 7.1, 7.2):
 * - `.mid` / `.midi` → parsed directly with {@link parseMidi}.
 * - `.wav` / `.mp3` / `.flac` / `.ogg` → transcribed to MIDI with Basic Pitch
 *   ({@link transcribeAudio}) and then parsed with the SAME {@link parseMidi}
 *   path, so audio and direct-MIDI inputs converge on one code path.
 *
 * Regardless of source, the resulting notes are run through
 * {@link validateNoteEvents} before returning, so transcription output is held
 * to exactly the same data contract as direct MIDI — unique ids, normalized
 * velocity, and valid timing (Requirement 7.5).
 *
 * @param inputPath Path to a MIDI or audio file.
 * @returns The normalized, validated, time-sorted `NoteEvent[]`.
 * @throws {InputError} if the extension is not a supported MIDI/audio format,
 *   or (from {@link parseMidi}) if a MIDI file is unreadable/malformed/empty.
 * @throws {TranscriptionError} if audio transcription fails (Python/Basic Pitch
 *   unavailable, non-zero exit, or no MIDI produced).
 * @throws {ValidationError} if the extracted notes violate the NoteEvent contract.
 */
export async function extract(inputPath: string): Promise<NoteEvent[]> {
  const ext = extname(inputPath).toLowerCase();

  let notes: NoteEvent[];
  if (MIDI_EXTENSIONS.has(ext)) {
    notes = await parseMidi(inputPath);
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    notes = await extractFromAudio(inputPath);
  } else {
    const supported = [...MIDI_EXTENSIONS, ...AUDIO_EXTENSIONS].join(', ');
    throw new InputError(
      `Unsupported input file type "${ext || '(no extension)'}" for ${inputPath}. ` +
        `Supported extensions: ${supported}.`,
      { filePath: inputPath },
    );
  }

  // Hold transcription output to the same contract as direct MIDI input
  // (Requirement 7.5). parseMidi already assigns unique ids and normalizes
  // velocity; validating here makes the guarantee explicit for both paths.
  validateNoteEvents(notes);
  return notes;
}

/**
 * Transcribe an audio file to MIDI (Basic Pitch) and parse it into notes via
 * the same {@link parseMidi} path used for direct MIDI input (Requirement 7.2).
 *
 * {@link transcribeAudio} writes the MIDI into a dedicated temp directory it
 * does NOT clean up on success — the caller owns that. This function removes
 * the whole temp directory (the parent of the returned MIDI path) in a
 * `finally`, so the temp file is cleaned up on both success and failure of
 * parsing (Requirement 7.5 cleanup). The cleanup is guarded with `.catch()` so
 * a failure to remove the temp directory can never mask the parse result or a
 * parse error.
 *
 * `return await` is required here (not a bare `return`): it makes the `finally`
 * run only after parsing settles — otherwise the temp directory would be
 * deleted before {@link parseMidi} finishes reading the MIDI file.
 */
async function extractFromAudio(inputPath: string): Promise<NoteEvent[]> {
  const midiPath = await transcribeAudio(inputPath);
  try {
    return await parseMidi(midiPath);
  } finally {
    await rm(dirname(midiPath), { recursive: true, force: true }).catch(() => {});
  }
}
