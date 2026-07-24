// @motionscore/note-extractor
//
// Stage B: converts MIDI or audio into a normalized NoteEvent[]. Mixed audio
// defaults to smart librosa hit analysis; Basic Pitch remains an explicit
// full-transcription mode.
//
// `extract` is the compatibility entry point returning notes/hits only.
// `extractWithAnalysis` additionally preserves source duration, continuous
// features, and structural section cues for orchestration and future renderers.

import { readFile, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
// Basic Pitch audio-to-MIDI subprocess wrapper (task 11.1). Imported so the
// audio branch of `extract` can transcribe audio to MIDI, and re-exported so
// the note-extractor package surfaces both the MIDI and audio entry points.
import { transcribeAudio } from './transcribe.js';
// Rhythmic (beat/onset) audio analysis via librosa. Used for the default audio
// path so a full song yields a sparse set of hittable events instead of a dense
// transcription.
import {
  analyzeAudioEvents,
  extractAudioEvents,
  detectStemsGpuAvailable,
  type AudioEventExtractionMode,
  type BeatExtractionMode,
} from './audio-events.js';
// `@tonejs/midi` ships as a CommonJS bundle whose named exports Node's ESM
// loader cannot statically detect, so we default-import the module object
// (Node exposes `module.exports` as the default) and read `Midi` from it.
import midiModule from '@tonejs/midi';
import {
  InputError,
  validateNoteEvents,
  type AudioAnalysis,
  type NoteEvent,
} from '@motionscore/types';

export { transcribeAudio };
export {
  analyzeAudioEvents,
  extractAudioEvents,
  detectStemsGpuAvailable,
  type AudioEventExtractionMode,
  type BeatExtractionMode,
};

/**
 * How an input is turned into hittable events (audio only; MIDI is always
 * parsed as discrete notes):
 * - `'auto'`   — smart HPSS/frequency-band attack fusion for audio; direct
 *   notes for MIDI. This is the recommended full-song mode.
 * - `'beats'`  — metrical pulse tracking. Sparse, but may omit fills and
 *   syncopated instrumental accents.
 * - `'onsets'` — all full-mix attacks. Denser and less selective than auto.
 * - `'stems'`  — neural per-instrument separation (Demucs `htdemucs_6s`):
 *   isolates drums/bass/vocals/other/guitar/piano and detects onsets per stem,
 *   so each ball maps to a real instrument. Needs PyTorch + Demucs.
 * - `'notes'`  — full pitched transcription (Basic Pitch). Dense; suits sparse
 *   solo/instrumental recordings, and matches direct-MIDI fidelity.
 */
export type ExtractionMode = 'auto' | 'notes' | 'beats' | 'onsets' | 'stems';

/** Options controlling {@link extract}. */
export interface ExtractOptions {
  /** Extraction strategy for audio input (default `'auto'`). Ignored for MIDI. */
  mode?: ExtractionMode;
}

/** Stage B result retaining rich audio metadata when rhythmic analysis ran. */
export interface ExtractedInput {
  notes: NoteEvent[];
  audioAnalysis?: AudioAnalysis;
}

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
      source: 'midi',
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
 * Routing:
 * - `.mid` / `.midi` → parsed directly with {@link parseMidi} (the `mode` is
 *   ignored; a MIDI file is already discrete notes).
 * - `.wav` / `.mp3` / `.flac` / `.ogg` → routed by `mode`:
 *   - `beats` / `onsets` (and `auto`, which picks `smart`) → librosa audio
 *     analysis ({@link analyzeAudioEvents}). A role-labelled hittable set plus
 *     continuous features and section cues.
 *   - `notes` → full transcription to MIDI with Basic Pitch
 *     ({@link transcribeAudio}) then parsed via the SAME {@link parseMidi} path.
 *
 * Regardless of source, the resulting notes are run through
 * {@link validateNoteEvents} before returning, so every path is held to exactly
 * the same data contract — unique ids, normalized velocity, and valid timing
 * (Requirement 7.5).
 *
 * @param inputPath Path to a MIDI or audio file.
 * @param options Extraction options; `mode` selects the audio strategy.
 * @returns The normalized, validated, time-sorted `NoteEvent[]`.
 * @throws {InputError} if the extension is unsupported, a MIDI file is
 *   unreadable/malformed/empty, or an audio analysis produced no events.
 * @throws {TranscriptionError} if audio analysis/transcription fails (Python
 *   unavailable, non-zero exit, etc.).
 * @throws {ValidationError} if the extracted notes violate the NoteEvent contract.
 */
export async function extract(
  inputPath: string,
  options: ExtractOptions = {},
): Promise<NoteEvent[]> {
  return (await extractWithAnalysis(inputPath, options)).notes;
}

/**
 * Rich extraction entry point used by orchestration that must retain source
 * duration, feature frames, and section cues. `extract()` remains the compact
 * backward-compatible projection to `NoteEvent[]`.
 */
export async function extractWithAnalysis(
  inputPath: string,
  options: ExtractOptions = {},
): Promise<ExtractedInput> {
  const ext = extname(inputPath).toLowerCase();
  const mode = options.mode ?? 'auto';

  let result: ExtractedInput;
  if (MIDI_EXTENSIONS.has(ext)) {
    result = { notes: await parseMidi(inputPath) };
  } else if (AUDIO_EXTENSIONS.has(ext)) {
    result = await extractFromAudio(inputPath, mode);
  } else {
    const supported = [...MIDI_EXTENSIONS, ...AUDIO_EXTENSIONS].join(', ');
    throw new InputError(
      `Unsupported input file type "${ext || '(no extension)'}" for ${inputPath}. ` +
        `Supported extensions: ${supported}.`,
      { filePath: inputPath },
    );
  }

  validateNoteEvents(result.notes);
  return result;
}

/**
 * Turn an audio file into notes according to `mode`.
 *
 * `auto` uses smart pseudo-stem fusion; explicit `beats`/`onsets` retain the
 * comparison analyzers. All three return a rich {@link AudioAnalysis}, whose
 * hits remain compatible with `NoteEvent[]`. `notes` uses full Basic Pitch
 * transcription parsed through the shared {@link parseMidi} path.
 *
 * @throws {InputError} if a rhythmic analysis finds no events (with guidance to
 *   try a different mode).
 */
async function extractFromAudio(
  inputPath: string,
  mode: ExtractionMode,
): Promise<ExtractedInput> {
  // `auto` resolves to the smart pseudo-stem analyzer for audio. It fuses
  // percussive, bass-band, and harmonic attacks instead of following only the
  // metrical beat grid or transcribing every pitched note.
  const effectiveMode = mode === 'auto' ? 'smart' : mode;

  if (effectiveMode === 'notes') {
    return { notes: await transcribeAndParse(inputPath) };
  }

  const rhythmicMode: AudioEventExtractionMode = effectiveMode;
  const audioAnalysis = await analyzeAudioEvents(inputPath, rhythmicMode);
  if (audioAnalysis.hits.length === 0) {
    throw new InputError(
      `No ${rhythmicMode} events were detected in ${inputPath}. Try a different mode ` +
        `(e.g. mode "onsets" for every full-mix attack, or "notes" for full transcription).`,
      { filePath: inputPath },
    );
  }
  return { notes: audioAnalysis.hits, audioAnalysis };
}

/**
 * Transcribe an audio file to MIDI (Basic Pitch) and parse it into notes via
 * the same {@link parseMidi} path used for direct MIDI input.
 *
 * {@link transcribeAudio} writes the MIDI into a dedicated temp directory it
 * does NOT clean up on success — the caller owns that. This removes the whole
 * temp directory (the parent of the returned MIDI path) in a `finally`, so the
 * temp file is cleaned up on both success and failure of parsing. The cleanup
 * is guarded with `.catch()` so it can never mask the parse result or error.
 *
 * `return await` is required (not a bare `return`): it makes the `finally` run
 * only after parsing settles — otherwise the temp directory would be deleted
 * before {@link parseMidi} finishes reading the MIDI file.
 */
async function transcribeAndParse(inputPath: string): Promise<NoteEvent[]> {
  const midiPath = await transcribeAudio(inputPath);
  try {
    return await parseMidi(midiPath);
  } finally {
    await rm(dirname(midiPath), { recursive: true, force: true }).catch(() => {});
  }
}
