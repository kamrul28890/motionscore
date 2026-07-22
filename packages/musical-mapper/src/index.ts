// @motionscore/musical-mapper
//
// Stage C: transforms NoteEvents into positioned ChoreographyTargets with
// layout, color, and impact-size hints.
//
// Task 3.1 implements the primitive mapping functions (pitch -> x-position,
// pitch -> color, velocity -> impact size). Task 3.2 builds the full `mapNotes`
// mapper and density filtering on top of these primitives.

import {
  validateChoreographyTargets,
  type ChoreographyTarget,
  type LayoutConfig,
  type NoteEvent,
} from '@motionscore/types';

/** Number of pitch classes in the chromatic scale (one octave). */
const PITCH_CLASSES = 12;

/** Semitone distance of a perfect fifth; stepping by fifths cycles all 12
 * pitch classes, which orders the palette around the circle of fifths. */
const FIFTH_INTERVAL = 7;

/**
 * Circle-of-fifths color palette (12 hex colors), indexed by circle-of-fifths
 * position starting at C. Adjacent entries are a perfect fifth apart, which
 * keeps neighboring colors perceptually distinct.
 */
const CIRCLE_OF_FIFTHS_COLORS: readonly string[] = [
  '#FF0000', // C
  '#FF7700', // G
  '#FFFF00', // D
  '#77FF00', // A
  '#00FF00', // E
  '#00FF77', // B
  '#00FFFF', // F#/Gb
  '#0077FF', // Db
  '#0000FF', // Ab
  '#7700FF', // Eb
  '#FF00FF', // Bb
  '#FF0077', // F
];

/**
 * Map a MIDI pitch value to an x-position using a linear piano-key layout.
 *
 * The pitch is normalized within `pitchRange`, clamped to [0, 1], and scaled to
 * the canvas width. The mapping is monotonically non-decreasing — a higher
 * pitch never maps to a smaller x (Property 5) — and the output is always in
 * [0, canvasWidth] (Property 6).
 *
 * Preconditions (per design): `pitchMidi` in [0, 127], `canvasWidth > 0`,
 * `pitchRange[0] < pitchRange[1]`.
 *
 * @param pitchMidi MIDI note number to place.
 * @param canvasWidth Canvas width in pixels; the upper bound of the output.
 * @param pitchRange `[minPitch, maxPitch]` mapped across the full width.
 * @returns The x-coordinate in [0, canvasWidth].
 */
export function pitchToX(
  pitchMidi: number,
  canvasWidth: number,
  pitchRange: [number, number],
): number {
  const [minPitch, maxPitch] = pitchRange;
  const normalized = (pitchMidi - minPitch) / (maxPitch - minPitch);
  const clamped = Math.max(0, Math.min(1, normalized));
  return clamped * canvasWidth;
}

/**
 * Map a MIDI pitch to a hex color using circle-of-fifths ordering.
 *
 * The pitch class (`pitchMidi mod 12`) is reordered by perfect fifths and used
 * to index the palette. Because only the pitch class participates, a pitch and
 * its octave transpositions map to the same color — `color(P) === color(P+12)`
 * (Property 8).
 *
 * @param pitchMidi MIDI note number (design precondition: [0, 127]).
 * @returns A hex color string from the circle-of-fifths palette.
 */
export function pitchToColor(pitchMidi: number): string {
  // Normalize into [0, 11] so negative inputs still yield a valid pitch class:
  // JS `%` is sign-preserving (`-1 % 12` is `-1`, not `11`), so re-add and mod.
  const chromaticIndex = ((pitchMidi % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
  const fifthsIndex = (chromaticIndex * FIFTH_INTERVAL) % PITCH_CLASSES;
  const color = CIRCLE_OF_FIFTHS_COLORS[fifthsIndex];
  // `fifthsIndex` is always in [0, 11] and the palette has exactly 12 entries,
  // so this guard is defensive: it satisfies `noUncheckedIndexedAccess` and
  // would only trigger if the palette were mis-sized.
  if (color === undefined) {
    throw new RangeError(`No circle-of-fifths color for pitch ${pitchMidi}`);
  }
  return color;
}

/**
 * Map a normalized note velocity to an impact size.
 *
 * Velocity is already normalized to [0.0, 1.0] by the note-extraction stage, so
 * this is an identity pass-through. It is trivially monotonically
 * non-decreasing and range-preserving (Property 7): louder notes never produce
 * a smaller impact, and the output stays in [0.0, 1.0].
 *
 * @param velocity Normalized note velocity in [0.0, 1.0].
 * @returns The impact size in [0.0, 1.0].
 */
export function velocityToImpactSize(velocity: number): number {
  return velocity;
}

/**
 * Default MIDI pitch range mapped across the canvas width when a
 * `LayoutConfig` does not specify one: the 88-key piano range (A0 = 21 to
 * C8 = 108). This suits the 'piano-keys' layout and keeps typical melodic
 * content well within bounds; callers wanting the full MIDI span can pass
 * `pitchRange: [0, 127]`.
 */
const DEFAULT_PITCH_RANGE: readonly [number, number] = [21, 108];

/**
 * Width, in seconds, of each density-filtering bucket. Density is expressed in
 * notes-per-second, so a 1-second bucket lets a bucket's note count be compared
 * directly against `maxNotesPerSecond`.
 */
const DENSITY_BUCKET_SECONDS = 1;

/** Lexicographic string comparison (ASCII code-point order), used as a stable,
 * locale-independent final tiebreak so mapping output is deterministic. */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Build a ranking function for track priority: lower rank = higher priority.
 *
 * A note whose track appears earlier in `trackPriority` ranks above one that
 * appears later; notes with an unlisted or absent track rank last (they all
 * share the lowest priority). When no priority list is configured, every note
 * ranks equally so track priority becomes a no-op tiebreak.
 */
function buildTrackPriorityRank(
  trackPriority: readonly string[] | undefined,
): (track: string | undefined) => number {
  const LOWEST_PRIORITY = Number.MAX_SAFE_INTEGER;
  if (trackPriority === undefined || trackPriority.length === 0) {
    return () => LOWEST_PRIORITY;
  }
  const rankByTrack = new Map<string, number>();
  trackPriority.forEach((track, index) => {
    // Keep the first (highest-priority) index if a track is listed twice.
    if (!rankByTrack.has(track)) {
      rankByTrack.set(track, index);
    }
  });
  return (track) =>
    track === undefined ? LOWEST_PRIORITY : rankByTrack.get(track) ?? LOWEST_PRIORITY;
}

/**
 * Build the note-priority comparator used to decide which notes survive when a
 * dense passage is thinned (Requirement 3.5). Notes are ranked, highest
 * priority first, by:
 *   1. velocity, descending — louder notes are kept (task 3.2 detail);
 *   2. configured track priority — higher-priority tracks win ties;
 *   3. earlier onset, then id — a deterministic, total final tiebreak.
 */
function compareByPriority(
  config: LayoutConfig,
): (a: NoteEvent, b: NoteEvent) => number {
  const rankTrack = buildTrackPriorityRank(config.trackPriority);
  return (a, b) => {
    if (a.velocity !== b.velocity) {
      return b.velocity - a.velocity;
    }
    const rankA = rankTrack(a.track);
    const rankB = rankTrack(b.track);
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    if (a.startSec !== b.startSec) {
      return a.startSec - b.startSec;
    }
    return compareStrings(a.id, b.id);
  };
}

/**
 * Thin dense passages so no 1-second window exceeds `config.maxNotesPerSecond`
 * (Requirement 3.5).
 *
 * Notes are grouped into fixed 1-second buckets keyed by `floor(startSec)`; a
 * bucket's note count is exactly its notes-per-second density. Any bucket whose
 * count exceeds the threshold is reduced to its highest-priority
 * `floor(maxNotesPerSecond)` notes (see {@link compareByPriority}); other
 * buckets pass through untouched. Only whole notes are dropped, so the timing
 * of every surviving note is preserved.
 *
 * When `maxNotesPerSecond` is undefined, filtering is skipped and the input is
 * returned unchanged. The returned array's order is unspecified — callers sort
 * the final targets by time.
 */
function applyDensityFilter(
  notes: readonly NoteEvent[],
  config: LayoutConfig,
): readonly NoteEvent[] {
  const { maxNotesPerSecond } = config;
  if (maxNotesPerSecond === undefined) {
    return notes;
  }

  const buckets = new Map<number, NoteEvent[]>();
  for (const note of notes) {
    const bucketKey = Math.floor(note.startSec / DENSITY_BUCKET_SECONDS);
    const bucket = buckets.get(bucketKey);
    if (bucket === undefined) {
      buckets.set(bucketKey, [note]);
    } else {
      bucket.push(note);
    }
  }

  // Largest integer count of notes we may keep per 1-second bucket without
  // exceeding the threshold.
  const cap = Math.max(0, Math.floor(maxNotesPerSecond));
  const byPriority = compareByPriority(config);

  const retained: NoteEvent[] = [];
  for (const bucket of buckets.values()) {
    if (bucket.length > maxNotesPerSecond) {
      const ranked = [...bucket].sort(byPriority);
      for (const note of ranked.slice(0, cap)) {
        retained.push(note);
      }
    } else {
      for (const note of bucket) {
        retained.push(note);
      }
    }
  }
  return retained;
}

/**
 * Map a `NoteEvent[]` into positioned, colored `ChoreographyTarget[]` for the
 * Stage C boundary.
 *
 * For each note (after optional density thinning) the mapper derives:
 * - `position.x` from pitch via {@link pitchToX} (Requirement 3.1) using
 *   `config.pitchRange`, defaulting to the 88-key piano range;
 * - `position.y` from `config.targetY` (the target row);
 * - `impactSize` from velocity via {@link velocityToImpactSize} (Req 3.3);
 * - `colorHint` from pitch via {@link pitchToColor} (Req 3.4).
 *
 * Dense passages are thinned per `config.maxNotesPerSecond` (Req 3.5) and the
 * output is sorted by `timeSec` ascending, with `noteId` as a deterministic
 * tiebreak (Req 3.6). Before returning, the result is validated against the
 * ChoreographyTarget contract (Req 3.2): positions must fall within the canvas
 * bounds, and — because the source notes are supplied — every `noteId` must
 * reference an input note whose `startSec` matches the target's `timeSec`. A
 * failing check (e.g. a `config.targetY` outside `[0, canvasHeight]`) throws a
 * `ValidationError` identifying the offending field.
 *
 * @param notes Source note events (each target references one by id).
 * @param config Layout configuration (canvas size, target row, pitch range,
 *   and optional density-filter fields).
 * @returns Time-sorted choreography targets; length is <= `notes.length`.
 * @throws {ValidationError} if any produced target violates the contract.
 */
export function mapNotes(
  notes: NoteEvent[],
  config: LayoutConfig,
): ChoreographyTarget[] {
  const pitchRange: [number, number] = config.pitchRange ?? [
    DEFAULT_PITCH_RANGE[0],
    DEFAULT_PITCH_RANGE[1],
  ];

  const retained = applyDensityFilter(notes, config);

  const targets: ChoreographyTarget[] = retained.map((note) => ({
    noteId: note.id,
    timeSec: note.startSec,
    position: {
      x: pitchToX(note.pitchMidi, config.canvasWidth, pitchRange),
      y: config.targetY,
    },
    impactSize: velocityToImpactSize(note.velocity),
    colorHint: pitchToColor(note.pitchMidi),
  }));

  // Chronological order (Req 3.6); id tiebreak keeps equal-time output stable.
  targets.sort(
    (a, b) => a.timeSec - b.timeSec || compareStrings(a.noteId, b.noteId),
  );

  // Enforce the Stage C output contract before returning (Req 3.2). Passing the
  // source notes also verifies noteId references and timeSec/startSec agreement.
  validateChoreographyTargets(
    targets,
    config.canvasWidth,
    config.canvasHeight,
    notes,
  );

  return targets;
}
