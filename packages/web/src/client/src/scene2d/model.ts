// Deterministic neural-to-physics race planner.
//
// Music fixes anchor times and target positions first. Unsupported intervals are
// then solved backward as exact constant-gravity arcs; separated sustained
// activity creates supported cubic slides. A contact line is derived from the
// incoming/outgoing velocity bisector, so the visible geometry explains the
// motion instead of decorating an unrelated waveform.

import type {
  AudioAnalysis,
  HitRole,
  NoteEvent,
  PitchDirection,
  RoleSignalTrack,
  SectionCue,
} from '../renderTypes.js';
import { type Scene2DSettings, getActorOverride } from './settings.js';
import type {
  Actor,
  ActorKind,
  BallisticSegment,
  MergeSuggestion,
  RaceContact,
  RaceSegment,
  Scene2DModel,
  SlideSegment,
  Vec2,
} from './types.js';

/** World units travelled rightward per second. */
export const SCROLL_X = 6;
/** Global contact-line descent per second (positive canvas Y is down). */
export const DRIFT_Y = 0.72;
/** One constant gravity for every unsupported actor segment. */
export const GRAVITY = 18;
export const BALL_R = 0.23;

const GROUP_GAP = 2.2;
const RACE_X_GAP = 0.68;
/** Upward surge (world units) at full sustained neural activity for pitched actors. */
const SUSTAIN_SWELL_LIFT = 4.5;
/**
 * Peak height (world units) a pitched freefall arc may reach over a long rest.
 * A long gap keeps ONE dramatic arc (the ball flies up and returns) but its
 * gravity is reduced so it never escapes to infinity.
 */
const APEX_MAX_PITCHED = 10;

/**
 * A rest longer than this (for a pitched actor) is treated as a real silence:
 * the ball leaves the screen entirely and re-enters on the next onset, instead
 * of floating mid-screen. Below it, a gap stays a bounded arc (the liked
 * fly-up-and-return). Also bounded by ~10 beats so it scales with tempo.
 */
const LONG_SILENCE_MIN_SEC = 6;
/** Distance (world units) a dormant ball is pushed off-screen. */
const OFFSCREEN_DIST = 55;
/** Seconds the ball spends visibly leaving the frame / dropping back in. */
const OFFSCREEN_TRANSIT_SEC = 0.9;
/** Max world-unit drift a manual tilt may add, so it can't force a zoom-out. */
const MAX_TILT_OFFSET = 6;
const CONTACT_STACK_GAP = BALL_R * 2.8;
const EXACT_TIME_EPSILON = 1e-6;
const Q8 = 255;

export interface GroupDefinition {
  id: string;
  kind: ActorKind;
  label: string;
  color: string;
  roles: readonly HitRole[];
}

/**
 * The fixed set of semantic race actors. Enabled source roles are grouped into
 * these, so the scene shows at most three balls. The UI must toggle visibility
 * at this actor granularity (or per stem within a group) using `color`, which
 * is the actual ball tint — role palettes are unrelated to what is drawn.
 */
export const ACTOR_GROUPS: readonly GroupDefinition[] = [
  {
    id: 'rhythm',
    kind: 'rhythm',
    label: 'Rhythm',
    color: '#ef476f',
    roles: ['kick', 'snare', 'percussion'],
  },
  {
    id: 'bass',
    kind: 'bass',
    label: 'Bass',
    color: '#f59f00',
    roles: ['bass'],
  },
  {
    id: 'lead',
    kind: 'lead',
    label: 'Lead',
    color: '#3b82f6',
    roles: ['melodic', 'piano', 'guitar', 'vocal'],
  },
];

/** Default physics family + display name + tint per source role. */
const ROLE_ACTOR_META: Record<HitRole, { kind: ActorKind; label: string; color: string }> = {
  kick: { kind: 'rhythm', label: 'Kick', color: '#ff6b6b' },
  snare: { kind: 'rhythm', label: 'Snare', color: '#ffd43b' },
  percussion: { kind: 'rhythm', label: 'Percussion', color: '#63e6be' },
  bass: { kind: 'bass', label: 'Bass', color: '#ffa94d' },
  melodic: { kind: 'lead', label: 'Melody', color: '#4dabf7' },
  piano: { kind: 'lead', label: 'Piano', color: '#b197fc' },
  guitar: { kind: 'lead', label: 'Guitar', color: '#f783ac' },
  vocal: { kind: 'lead', label: 'Vocals', color: '#a9e34b' },
};

const ROLE_SEQUENCE: readonly HitRole[] = [
  'kick', 'snare', 'percussion', 'bass', 'melodic', 'piano', 'guitar', 'vocal',
];

/**
 * Default grouping: one ball per sound, named and coloured by the sound itself.
 * Users can regroup freely; this is only the starting point when no custom
 * grouping is supplied.
 */
export const DEFAULT_ROLE_ACTORS: readonly GroupDefinition[] = ROLE_SEQUENCE.map((role) => ({
  id: role,
  kind: ROLE_ACTOR_META[role].kind,
  label: ROLE_ACTOR_META[role].label,
  color: ROLE_ACTOR_META[role].color,
  roles: [role],
}));

interface GroupSignal {
  frameRateHz: number;
  activity: Float32Array;
  direction: Int8Array;
}

interface SupportSpan {
  startSec: number;
  endSec: number;
}

interface Anchor {
  timeSec: number;
  position: Vec2;
  contact: RaceContact | null;
}

interface ActorDraft {
  actor: Actor;
  anchors: Anchor[];
  anchorByContact: Map<RaceContact, Anchor>;
  supportSpans: SupportSpan[];
  signal: GroupSignal;
  cues: readonly SectionCue[];
  /** Long silences (contact pairs) where the ball flies off-screen and back. */
  longGaps: Array<[from: RaceContact, to: RaceContact]>;
}

interface ContactReference {
  actorIndex: number;
  contact: RaceContact;
}

interface ConvergenceCluster {
  centerSec: number;
  refs: ContactReference[];
  score: number;
}

interface AdjustmentKey {
  timeSec: number;
  deltaY: number;
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

const smoothstep = (value: number): number => {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
};

const magnitude = (value: Vec2): number => Math.hypot(value.x, value.y);

function normalized(value: Vec2, fallback: Vec2 = { x: 1, y: 0 }): Vec2 {
  const length = magnitude(value);
  if (length <= 1e-9) return { ...fallback };
  return { x: value.x / length, y: value.y / length };
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

function beatDuration(analysis: AudioAnalysis): number {
  return analysis.tempoBpm > 0 ? 60 / analysis.tempoBpm : 0.5;
}

function trackByRole(analysis: AudioAnalysis): Map<HitRole, RoleSignalTrack> {
  const result = new Map<HitRole, RoleSignalTrack>();
  for (const track of analysis.roleSignals?.tracks ?? []) result.set(track.role, track);
  return result;
}

function buildGroupSignal(
  analysis: AudioAnalysis,
  roles: readonly HitRole[],
  settings: Scene2DSettings,
): GroupSignal {
  const frameRateHz = analysis.roleSignals?.frameRateHz ?? 10;
  const frameCount = analysis.roleSignals?.frameCount ?? 0;
  const activity = new Float32Array(frameCount);
  const directionNumerator = new Float32Array(frameCount);
  const directionWeight = new Float32Array(frameCount);
  const tracks = trackByRole(analysis);

  for (const role of roles) {
    if (!settings.roleVisible[role]) continue;
    const track = tracks.get(role);
    if (!track) continue;
    for (let index = 0; index < frameCount; index += 1) {
      const roleActivity = (track.activityQ8[index] ?? 0) / Q8;
      if (roleActivity > activity[index]!) activity[index] = roleActivity;
      const direction = track.pitchDirection?.[index];
      if (direction !== undefined && direction !== 0 && roleActivity > 0) {
        directionNumerator[index]! += direction * roleActivity;
        directionWeight[index]! += roleActivity;
      }
    }
  }

  const direction = new Int8Array(frameCount);
  for (let index = 0; index < frameCount; index += 1) {
    if (directionWeight[index]! <= 0) continue;
    const value = directionNumerator[index]! / directionWeight[index]!;
    direction[index] = value > 0.2 ? 1 : value < -0.2 ? -1 : 0;
  }
  return { frameRateHz, activity, direction };
}

function signalActivity(signal: GroupSignal, timeSec: number): number {
  if (signal.activity.length === 0) return 0;
  const position = clamp(timeSec * signal.frameRateHz, 0, signal.activity.length - 1);
  const left = Math.floor(position);
  const right = Math.min(signal.activity.length - 1, left + 1);
  const fraction = position - left;
  return signal.activity[left]! * (1 - fraction) + signal.activity[right]! * fraction;
}

function signalDirection(signal: GroupSignal, timeSec: number): PitchDirection {
  if (signal.direction.length === 0) return 0;
  const index = Math.round(clamp(timeSec * signal.frameRateHz, 0, signal.direction.length - 1));
  const value = signal.direction[index] ?? 0;
  return value === 1 ? 1 : value === -1 ? -1 : 0;
}

function deriveSupportSpans(
  signal: GroupSignal,
  kind: ActorKind,
  cues: readonly SectionCue[],
  durationSec: number,
  beatSec: number,
): SupportSpan[] {
  if (kind === 'rhythm') return [];
  const minimumDuration = Math.max(0.24, beatSec * 0.65);
  const spans: SupportSpan[] = [];

  if (signal.activity.length > 0) {
    let active = false;
    let startFrame = 0;
    let lowRun = 0;
    for (let index = 0; index < signal.activity.length; index += 1) {
      const value = signal.activity[index]!;
      if (!active) {
        if (value >= 0.3) {
          active = true;
          startFrame = index;
          lowRun = 0;
        }
        continue;
      }
      if (value <= 0.18) {
        lowRun += 1;
        if (lowRun >= 2) {
          const endFrame = index - 1;
          const startSec = startFrame / signal.frameRateHz;
          const endSec = Math.min(durationSec, endFrame / signal.frameRateHz);
          if (endSec - startSec >= minimumDuration) spans.push({ startSec, endSec });
          active = false;
          lowRun = 0;
        }
      } else {
        lowRun = 0;
      }
    }
    if (active) {
      const startSec = startFrame / signal.frameRateHz;
      if (durationSec - startSec >= minimumDuration) spans.push({ startSec, endSec: durationSec });
    }
    return spans;
  }

  // Legacy analyzer fallback: structural rises/falls are continuous by nature.
  for (const cue of cues) {
    if ((cue.type === 'rise' || cue.type === 'fall') && cue.endSec - cue.startSec >= minimumDuration) {
      spans.push({ startSec: cue.startSec, endSec: cue.endSec });
    }
  }
  return spans;
}

function isSupported(spans: readonly SupportSpan[], t0: number, t1: number): boolean {
  if (t1 <= t0) return false;
  const midpoint = (t0 + t1) / 2;
  return spans.some((span) => midpoint >= span.startSec && midpoint <= span.endSec);
}

function groupNotes(
  analysis: AudioAnalysis,
  group: GroupDefinition,
  settings: Scene2DSettings,
): NoteEvent[] {
  return analysis.hits.filter((note) => {
    if (note.role === undefined) return group.kind === 'lead';
    return group.roles.includes(note.role) && settings.roleVisible[note.role];
  });
}

function hasSignalActivity(signal: GroupSignal): boolean {
  // Require a meaningful sustained level, not any non-zero value: separation
  // bleed sits around 0.1-0.2 and must NOT spawn a phantom actor. A role with
  // real discrete onsets still spawns via the notes.length check upstream.
  for (const value of signal.activity) if (value >= 0.3) return true;
  return false;
}

function buildContacts(notes: readonly NoteEvent[], actorId: string, rapidThreshold: number): RaceContact[] {
  const sorted = [...notes].sort(
    (a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id),
  );
  const contacts: RaceContact[] = [];
  for (const note of sorted) {
    const previous = contacts[contacts.length - 1];
    const strength = clamp(note.salience ?? note.velocity, 0, 1);
    if (previous && Math.abs(previous.timeSec - note.startSec) <= EXACT_TIME_EPSILON) {
      const oldCount = previous.noteIds.length;
      previous.noteIds.push(note.id);
      if (note.role !== undefined && !previous.sourceRoles.includes(note.role)) {
        previous.sourceRoles.push(note.role);
      }
      previous.pitchMidi = (previous.pitchMidi * oldCount + note.pitchMidi) / (oldCount + 1);
      previous.strength = Math.max(previous.strength, strength);
      continue;
    }
    contacts.push({
      id: `${actorId}-contact-${contacts.length}`,
      timeSec: note.startSec,
      noteIds: [note.id],
      sourceRoles: note.role === undefined ? [] : [note.role],
      strength,
      pitchMidi: note.pitchMidi,
      rapid: false,
      intentionalConvergence: false,
      position: { x: 0, y: 0 },
      surfacePoint: { x: 0, y: 0 },
      tangent: { x: 1, y: 0 },
      normal: { x: 0, y: 1 },
      lineLength: BALL_R * 5,
      supportLength: 0,
      incomingSpeed: 0,
      style: 'kicker',
    });
  }
  for (let index = 1; index < contacts.length; index += 1) {
    if (contacts[index]!.timeSec - contacts[index - 1]!.timeSec <= rapidThreshold) {
      contacts[index]!.rapid = true;
      contacts[index - 1]!.rapid = true;
    }
  }
  return contacts;
}

function medianPitch(contacts: readonly RaceContact[]): number {
  if (contacts.length === 0) return 60;
  const pitches = contacts.map((contact) => contact.pitchMidi).sort((a, b) => a - b);
  const middle = Math.floor(pitches.length / 2);
  return pitches.length % 2 === 0
    ? (pitches[middle - 1]! + pitches[middle]!) / 2
    : pitches[middle]!;
}

function cueAt(cues: readonly SectionCue[], timeSec: number, type: SectionCue['type']): number {
  let result = 0;
  for (const cue of cues) {
    if (cue.type !== type || timeSec < cue.startSec || timeSec > cue.endSec) continue;
    const confidence = clamp(cue.confidence, 0, 1);
    result = Math.max(result, clamp(cue.intensity, 0, 1) * confidence);
  }
  return result;
}

function macroOffset(cues: readonly SectionCue[], timeSec: number): number {
  let offset = 0;
  for (const cue of cues) {
    if (timeSec < cue.startSec || timeSec > cue.endSec) continue;
    const span = Math.max(1e-6, cue.endSec - cue.startSec);
    const progress = smoothstep((timeSec - cue.startSec) / span);
    const amount = clamp(cue.intensity * cue.confidence, 0, 1);
    if (cue.type === 'build' || cue.type === 'rise') offset -= 1.8 * amount * progress;
    else if (cue.type === 'fall') offset += 1.5 * amount * progress;
    else if (cue.type === 'breakdown') offset += 0.8 * amount * progress;
    else if (cue.type === 'drop') {
      const peak = cue.peakSec ?? (cue.startSec + cue.endSec) / 2;
      const distance = Math.abs(timeSec - peak) / span;
      offset += 2.6 * amount * (1 - clamp(distance, 0, 1));
    }
  }
  return offset;
}

function rhythmOffset(contact: RaceContact): number {
  if (contact.sourceRoles.length === 0) return 0;
  // Small, consistent baseline bias per sub-role so kick/snare/percussion stay
  // distinguishable without breaking the clean bounce. Large offsets here make
  // consecutive contacts zig-zag and tilt the connecting arc, so keep them
  // within roughly one ball radius.
  let total = 0;
  for (const role of contact.sourceRoles) {
    if (role === 'kick') total += 0.2;
    else if (role === 'snare') total -= 0.16;
    else if (role === 'percussion') total += 0.06;
  }
  return (total / contact.sourceRoles.length) * (0.6 + 0.4 * contact.strength);
}

interface ActiveRange {
  startSec: number;
  endSec: number;
}

/**
 * The time span where an actor has real content (first→last contact or support
 * boundary). Outside this range the actor is idle and is not sampled/drawn, so
 * a role that only enters mid-song (e.g. a vocal that starts at 0:21) does not
 * bounce on empty paper during the intro.
 */
function activeRange(
  contacts: readonly RaceContact[],
  supportSpans: readonly SupportSpan[],
): ActiveRange | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const contact of contacts) {
    start = Math.min(start, contact.timeSec);
    end = Math.max(end, contact.timeSec);
  }
  for (const span of supportSpans) {
    start = Math.min(start, span.startSec);
    end = Math.max(end, span.endSec);
  }
  if (!Number.isFinite(start)) return null;
  // A single instantaneous contact still deserves a ball; give it a small span
  // so it has a valid, non-degenerate time range.
  if (end <= start) end = start + 0.5;
  return { startSec: start, endSec: end };
}

/** True if some contact sits inside `span` (within `margin` seconds of it). */
function spanHasContact(
  span: SupportSpan,
  contacts: readonly RaceContact[],
  margin: number,
): boolean {
  return contacts.some(
    (c) => c.timeSec >= span.startSec - margin && c.timeSec <= span.endSec + margin,
  );
}

/**
 * Long silences for a pitched actor: gaps between consecutive contacts longer
 * than the threshold with no genuine support in the middle. These become the
 * "ball leaves the screen and re-enters" intervals. Bleed-only sustain (already
 * dropped upstream) never counts as support here.
 */
function longSilenceGaps(
  contacts: readonly RaceContact[],
  supportSpans: readonly SupportSpan[],
  beatSec: number,
): Array<[RaceContact, RaceContact]> {
  const threshold = Math.max(beatSec * 10, LONG_SILENCE_MIN_SEC);
  const sorted = [...contacts].sort((a, b) => a.timeSec - b.timeSec);
  const gaps: Array<[RaceContact, RaceContact]> = [];
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (b.timeSec - a.timeSec <= threshold) continue;
    if (isSupported(supportSpans, a.timeSec + 0.01, b.timeSec - 0.01)) continue;
    gaps.push([a, b]);
  }
  return gaps;
}

/** Nominal half-height (world units) each actor kind sweeps around its lane. */
function laneHalfHeight(kind: ActorKind): number {
  if (kind === 'rhythm') return 1.4; // bounded hops
  if (kind === 'bass') return 2.4; // heavier catches + some sustain
  return 3.4; // lead: swell + arcs reach furthest
}

/**
 * Auto-position the actors vertically so the scene reads less crowded: order
 * balls by register (a high instrument sits above a low one) and allocate the
 * gap between neighbours in proportion to how far each actually swings, all
 * within roughly the current footprint. Returns a lane centre per actor index.
 */
export function computeLaneCenters(
  entries: ReadonlyArray<{ kind: ActorKind; contacts: readonly RaceContact[] }>,
): number[] {
  const n = entries.length;
  const centers = new Array<number>(n).fill(0);
  if (n <= 1) return centers;

  const half = entries.map((e) => laneHalfHeight(e.kind));
  const register = entries.map((e) => medianPitch(e.contacts));
  // High register first → most negative y (top of screen, since +y is down).
  const order = [...entries.keys()].sort((a, b) => register[b]! - register[a]! || a - b);

  const margin = BALL_R * 2;
  const gaps: number[] = [];
  for (let i = 0; i + 1 < n; i += 1) {
    gaps.push(half[order[i]!]! + half[order[i + 1]!]! + margin);
  }
  const sum = gaps.reduce((s, g) => s + g, 0) || 1;
  // Keep the total spread close to the old uniform layout (slightly roomier),
  // so the camera zoom is unaffected while spacing is redistributed by amplitude.
  const target = (n - 1) * GROUP_GAP * 1.15;
  const scale = target / sum;

  const byOrder = [0];
  for (let i = 0; i < gaps.length; i += 1) byOrder.push(byOrder[i]! + gaps[i]! * scale);
  const mean = byOrder.reduce((s, c) => s + c, 0) / n;
  order.forEach((actorIndex, k) => {
    centers[actorIndex] = byOrder[k]! - mean;
  });
  return centers;
}

/**
 * Suggest merging two balls when their onsets nearly always coincide (within a
 * small window): they would draw on top of each other, so one ball is clearer.
 * Score = fraction of the sparser ball's onsets that have a partner in the
 * other. Only confident, well-populated pairs are returned, strongest first.
 */
export function computeMergeSuggestions(actors: readonly Actor[], beatSec: number): MergeSuggestion[] {
  const window = Math.min(0.08, beatSec * 0.2);
  const minContacts = 12;
  const minScore = 0.6;
  const suggestions: MergeSuggestion[] = [];

  for (let i = 0; i < actors.length; i += 1) {
    for (let j = i + 1; j < actors.length; j += 1) {
      const a = actors[i]!;
      const b = actors[j]!;
      const ta = a.hitTimes;
      const tb = b.hitTimes;
      if (ta.length < minContacts || tb.length < minContacts) continue;

      // Count onsets of the SPARSER ball that have a partner within `window`.
      const [few, many] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
      let matches = 0;
      let p = 0;
      for (let k = 0; k < few.length; k += 1) {
        const t = few[k]!;
        while (p < many.length - 1 && many[p]! < t - window) p += 1;
        if (Math.abs(many[p]! - t) <= window) matches += 1;
      }
      const score = matches / few.length;
      if (score < minScore) continue;
      // Merge the sparser ball into the denser one (denser = primary identity).
      const [primary, secondary] = a.contacts.length >= b.contacts.length ? [a, b] : [b, a];
      suggestions.push({
        aId: primary.id,
        bId: secondary.id,
        aLabel: primary.label,
        bLabel: secondary.label,
        score: Math.round(score * 100) / 100,
      });
    }
  }

  suggestions.sort((x, y) => y.score - x.score);
  return suggestions.slice(0, 3);
}

function createAnchors(
  contacts: readonly RaceContact[],
  supportSpans: readonly SupportSpan[],
  range: ActiveRange,
  beatSec: number,
  subdivide: boolean,
): { anchors: Anchor[]; anchorByContact: Map<RaceContact, Anchor> } {
  const raw: Array<{ timeSec: number; contact: RaceContact | null }> = [
    { timeSec: range.startSec, contact: null },
    { timeSec: range.endSec, contact: null },
  ];
  for (const contact of contacts) raw.push({ timeSec: contact.timeSec, contact });
  for (const span of supportSpans) {
    if (span.startSec > range.startSec && span.startSec < range.endSec) raw.push({ timeSec: span.startSec, contact: null });
    if (span.endSec > range.startSec && span.endSec < range.endSec) raw.push({ timeSec: span.endSec, contact: null });
  }
  raw.sort((a, b) => a.timeSec - b.timeSec || (a.contact ? -1 : 1));

  const deduped: Anchor[] = [];
  const anchorByContact = new Map<RaceContact, Anchor>();
  for (const item of raw) {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(previous.timeSec - item.timeSec) <= EXACT_TIME_EPSILON) {
      if (item.contact !== null) {
        previous.contact = item.contact;
        anchorByContact.set(item.contact, previous);
      }
      continue;
    }
    const anchor: Anchor = {
      timeSec: item.timeSec,
      position: { x: 0, y: 0 },
      contact: item.contact,
    };
    deduped.push(anchor);
    if (item.contact !== null) anchorByContact.set(item.contact, anchor);
  }

  // Only BOUNCING (rhythm) actors subdivide long unsupported gaps into a series
  // of short, low hops. The cap is derived from a target apex (apex = g*dt^2/8),
  // so a drum silence reads as a settling bounce, never a tall near-vertical
  // "teleport" hop. Pitched actors deliberately keep a single (gravity-bounded)
  // freefall arc per gap instead — that is the dramatic fly-up-and-return, not a
  // string of bounces on empty paper.
  if (!subdivide) return { anchors: deduped, anchorByContact };
  const maxBallisticSec = Math.max(beatSec * 2, 0.95);
  const anchors: Anchor[] = [];
  for (let index = 0; index < deduped.length; index += 1) {
    if (index > 0) {
      const left = deduped[index - 1]!;
      const right = deduped[index]!;
      const gap = right.timeSec - left.timeSec;
      if (gap > maxBallisticSec && !isSupported(supportSpans, left.timeSec, right.timeSec)) {
        const pieces = Math.ceil(gap / maxBallisticSec);
        for (let k = 1; k < pieces; k += 1) {
          anchors.push({
            timeSec: left.timeSec + (gap * k) / pieces,
            position: { x: 0, y: 0 },
            contact: null,
          });
        }
      }
    }
    anchors.push(deduped[index]!);
  }
  return { anchors, anchorByContact };
}

function planPreliminaryAnchors(
  anchors: Anchor[],
  laneCenter: number,
  xBias: number,
  kind: ActorKind,
  contacts: readonly RaceContact[],
  supportSpans: readonly SupportSpan[],
  signal: GroupSignal,
  cues: readonly SectionCue[],
  beatSec: number,
  rapidThreshold: number,
): void {
  const baseBand = laneCenter;
  const pitchCenter = medianPitch(contacts);
  let depth = 0;
  let rapidRun = 0;

  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index]!;
    const previous = anchors[index - 1];
    const dt = previous ? anchor.timeSec - previous.timeSec : 0;
    const supported = previous ? isSupported(supportSpans, previous.timeSec, anchor.timeSec) : false;

    if (previous) {
      if (kind === 'rhythm') {
        // A bouncing actor rides a gently drifting baseline; every gap becomes
        // an upward hop whose height comes from constant gravity between two
        // near-level contacts. Accumulating freefall "depth" here would drag
        // contacts downward and invert the arc into a sag, so it is skipped.
        depth = 0;
      } else if (supported) {
        depth *= Math.exp(-dt / Math.max(beatSec * 5, 0.5));
      } else {
        // Freefall depth eases toward a BOUNDED rest offset instead of growing
        // as g*t^2 forever. Combined with gap subdivision in createAnchors, a
        // silent actor settles just below its baseline and gently bobs rather
        // than accelerating off-screen to infinity.
        const settleSec = Math.max(beatSec * 1.5, 0.6);
        const restDepth = 0.5 * GRAVITY * settleSec * settleSec * 0.42;
        const unpowered = Math.min(Math.max(0, dt - beatSec * 0.65), settleSec);
        depth *= Math.exp(-dt / Math.max(beatSec * 14, 1));
        depth = Math.min(depth + 0.42 * 0.5 * GRAVITY * unpowered * unpowered, restDepth);
      }
    }

    const contact = anchor.contact;
    let musicalOffset = 0;
    if (contact !== null) {
      // Pitched actors map absolute register to height (a higher note sits
      // higher). Coefficient raised from 0.055 so a high held vocal reads as a
      // clear vertical rise, not a flat glide.
      if (kind === 'rhythm') musicalOffset += rhythmOffset(contact);
      else musicalOffset -= (contact.pitchMidi - pitchCenter) * 0.1;

      if (contact.rapid && dt <= rapidThreshold + EXACT_TIME_EPSILON) rapidRun += 1;
      else rapidRun = 0;
      // A short bounded descending staircase for rapid runs; capped so a long
      // roll cannot drift far off the baseline and then snap back abruptly.
      if (rapidRun > 0) musicalOffset += Math.min(rapidRun, 4) * BALL_R * 0.9;
    } else if (supported) {
      musicalOffset -= signalDirection(signal, anchor.timeSec) * 0.3;
    }

    anchor.position.x = anchor.timeSec * SCROLL_X + xBias;
    const desiredY =
      anchor.timeSec * DRIFT_Y +
      baseBand +
      depth +
      macroOffset(cues, anchor.timeSec) +
      musicalOffset;
    if (previous && supported) {
      // During legato activity, individual internal onsets remain exact joints
      // but must not turn one held rail into a jagged polyline. Follow register
      // direction continuously and ease the absolute pitch target toward it.
      const midpoint = (previous.timeSec + anchor.timeSec) / 2;
      const direction = signalDirection(signal, midpoint);
      const macroDelta = macroOffset(cues, anchor.timeSec) - macroOffset(cues, previous.timeSec);
      const continuousY =
        previous.position.y + DRIFT_Y * dt - direction * 0.58 * dt + macroDelta;
      const settle = 1 - Math.exp(-dt / Math.max(beatSec * 1.6, 0.3));
      anchor.position.y = continuousY + (desiredY - continuousY) * settle;
    } else {
      anchor.position.y = desiredY;
    }

    // Sustained, high-activity material surges a pitched actor upward directly
    // (not eased), so a held swell — the singer leaning into a long loud note —
    // reacts strongly and recedes as activity fades, instead of gliding flat.
    // Applied after the baseline/rail Y so it is a real reaction on top of it.
    if (kind !== 'rhythm') {
      const activityHere = signalActivity(signal, anchor.timeSec);
      if (activityHere > 0.35) anchor.position.y -= SUSTAIN_SWELL_LIFT * (activityHere - 0.35);
    }
    if (contact !== null) contact.position = anchor.position;
  }
}

/**
 * Guarantee every rhythm gap is an upward hop. Under one constant downward
 * gravity the arc between two anchors is fully determined, so it only bounces
 * up when the endpoints do not descend faster than the launch can carry the
 * ball: dy <= 0.5*g*dt^2. Applied after all offsets and convergence so no
 * musical bias, rapid staircase, or crossover can invert a bounce into a sag
 * (which would also corrupt the derived contact normal/surface).
 */
function enforceRhythmHops(anchors: readonly Anchor[]): void {
  const SAFETY = 0.85;
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1]!;
    const current = anchors[index]!;
    const dt = current.timeSec - previous.timeSec;
    if (dt <= EXACT_TIME_EPSILON) continue;
    const hopLimit = 0.5 * GRAVITY * dt * dt * SAFETY;
    const maxY = previous.position.y + hopLimit;
    if (current.position.y > maxY) current.position.y = maxY;
  }
}

function clusterContacts(
  drafts: readonly ActorDraft[],
  beatSec: number,
  cues: readonly SectionCue[],
): ConvergenceCluster[] {
  const refs: ContactReference[] = [];
  drafts.forEach((draft, actorIndex) => {
    for (const contact of draft.actor.contacts) refs.push({ actorIndex, contact });
  });
  refs.sort((a, b) => a.contact.timeSec - b.contact.timeSec);
  const syncWindow = Math.min(0.085, beatSec * 0.22);
  const clusters: ConvergenceCluster[] = [];

  for (let cursor = 0; cursor < refs.length; ) {
    const start = refs[cursor]!.contact.timeSec;
    const candidates: ContactReference[] = [];
    let end = cursor;
    while (end < refs.length && refs[end]!.contact.timeSec - start <= syncWindow) {
      candidates.push(refs[end]!);
      end += 1;
    }
    const byActor = new Map<number, ContactReference>();
    for (const candidate of candidates) {
      const existing = byActor.get(candidate.actorIndex);
      if (!existing || candidate.contact.strength > existing.contact.strength) {
        byActor.set(candidate.actorIndex, candidate);
      }
    }
    if (byActor.size >= 2) {
      const unique = [...byActor.values()];
      const centerSec = unique.reduce((sum, ref) => sum + ref.contact.timeSec, 0) / unique.length;
      const meanStrength = unique.reduce((sum, ref) => sum + ref.contact.strength, 0) / unique.length;
      const drop = cueAt(cues, centerSec, 'drop');
      clusters.push({
        centerSec,
        refs: unique,
        score: unique.length * 10 + meanStrength + drop * 4,
      });
    }
    cursor = Math.max(cursor + 1, end);
  }

  // One strongest shared musical moment per eight-beat phrase. This creates
  // intentional choreography without inventing random crossings.
  const phraseSec = Math.max(beatSec * 8, 1.5);
  const bestByPhrase = new Map<number, ConvergenceCluster>();
  for (const cluster of clusters) {
    const phrase = Math.floor(cluster.centerSec / phraseSec);
    const existing = bestByPhrase.get(phrase);
    if (!existing || cluster.score > existing.score) bestByPhrase.set(phrase, cluster);
  }
  return [...bestByPhrase.values()].sort((a, b) => a.centerSec - b.centerSec);
}

function normalizeAdjustmentKeys(keys: AdjustmentKey[], durationSec: number): AdjustmentKey[] {
  keys.sort((a, b) => a.timeSec - b.timeSec);
  const merged: AdjustmentKey[] = [];
  for (const key of keys) {
    const previous = merged[merged.length - 1];
    if (previous && Math.abs(previous.timeSec - key.timeSec) <= EXACT_TIME_EPSILON) {
      previous.deltaY = key.deltaY;
    } else {
      merged.push({ ...key });
    }
  }
  if (merged.length === 0 || merged[0]!.timeSec > 0) merged.unshift({ timeSec: 0, deltaY: 0 });
  if (merged[merged.length - 1]!.timeSec < durationSec) {
    merged.push({ timeSec: durationSec, deltaY: merged[merged.length - 1]!.deltaY });
  }
  return merged;
}

function adjustmentAt(keys: readonly AdjustmentKey[], timeSec: number): number {
  if (keys.length === 0 || timeSec <= keys[0]!.timeSec) return keys[0]?.deltaY ?? 0;
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index]!;
    if (timeSec > right.timeSec) continue;
    const left = keys[index - 1]!;
    const span = Math.max(EXACT_TIME_EPSILON, right.timeSec - left.timeSec);
    const blend = smoothstep((timeSec - left.timeSec) / span);
    return left.deltaY + (right.deltaY - left.deltaY) * blend;
  }
  return keys[keys.length - 1]!.deltaY;
}

function applyConvergences(
  drafts: ActorDraft[],
  clusters: readonly ConvergenceCluster[],
  durationSec: number,
): void {
  const keysByActor = drafts.map((): AdjustmentKey[] => [{ timeSec: 0, deltaY: 0 }]);

  clusters.forEach((cluster, clusterIndex) => {
    const prelimY = cluster.refs.map((ref) => {
      const anchor = drafts[ref.actorIndex]!.anchorByContact.get(ref.contact);
      return anchor?.position.y ?? ref.contact.position.y;
    });
    const commonY = prelimY.reduce((sum, value) => sum + value, 0) / prelimY.length;
    const ordered = [...cluster.refs].sort((a, b) => {
      const slotA = (a.actorIndex + clusterIndex) % drafts.length;
      const slotB = (b.actorIndex + clusterIndex) % drafts.length;
      return slotA - slotB;
    });
    ordered.forEach((ref, stackIndex) => {
      const draft = drafts[ref.actorIndex]!;
      const anchor = draft.anchorByContact.get(ref.contact);
      if (!anchor) return;
      const desiredY =
        commonY +
        (stackIndex - (ordered.length - 1) / 2) * CONTACT_STACK_GAP +
        (ref.contact.timeSec - cluster.centerSec) * DRIFT_Y;
      keysByActor[ref.actorIndex]!.push({
        timeSec: ref.contact.timeSec,
        deltaY: desiredY - anchor.position.y,
      });
      ref.contact.intentionalConvergence = true;
    });
  });

  drafts.forEach((draft, actorIndex) => {
    const keys = normalizeAdjustmentKeys(keysByActor[actorIndex]!, durationSec);
    for (const anchor of draft.anchors) {
      anchor.position.y += adjustmentAt(keys, anchor.timeSec);
      if (anchor.contact !== null) anchor.contact.position = anchor.position;
    }
  });
}

function buildSegments(draft: ActorDraft): RaceSegment[] {
  const segments: RaceSegment[] = [];
  const { anchors, supportSpans, signal, cues } = draft;
  // One tangent per musical anchor makes adjacent sustained cubic pieces C1
  // continuous. Their offset rail therefore joins instead of becoming a stack
  // of disconnected short bars at every internal onset.
  const anchorSlopes = anchors.map((anchor, index) => {
    const previous = anchors[Math.max(0, index - 1)]!;
    const next = anchors[Math.min(anchors.length - 1, index + 1)]!;
    const dx = next.position.x - previous.position.x;
    const geometricSlope =
      Math.abs(dx) > EXACT_TIME_EPSILON
        ? (next.position.y - previous.position.y) / dx
        : DRIFT_Y / SCROLL_X;
    const direction = signalDirection(signal, anchor.timeSec);
    const rise = cueAt(cues, anchor.timeSec, 'rise') + cueAt(cues, anchor.timeSec, 'build');
    const fall = cueAt(cues, anchor.timeSec, 'fall');
    const musicalSlope = DRIFT_Y / SCROLL_X - direction * 0.34 - rise * 0.16 + fall * 0.12;
    return geometricSlope * 0.68 + musicalSlope * 0.32;
  });
  for (let index = 0; index + 1 < anchors.length; index += 1) {
    const left = anchors[index]!;
    const right = anchors[index + 1]!;
    const duration = right.timeSec - left.timeSec;
    if (duration <= EXACT_TIME_EPSILON) continue;
    if (draft.actor.kind !== 'rhythm' && isSupported(supportSpans, left.timeSec, right.timeSec)) {
      const midpoint = (left.timeSec + right.timeSec) / 2;
      const direction = signalDirection(signal, midpoint);
      const dx = right.position.x - left.position.x;
      const leftSlope = anchorSlopes[index]!;
      const rightSlope = anchorSlopes[index + 1]!;
      const slide: SlideSegment = {
        kind: 'slide',
        t0: left.timeSec,
        t1: right.timeSec,
        p0: left.position,
        p1: right.position,
        c1: {
          x: left.position.x + dx / 3,
          y: left.position.y + (dx / 3) * leftSlope,
        },
        c2: {
          x: right.position.x - dx / 3,
          y: right.position.y - (dx / 3) * rightSlope,
        },
        activity: signalActivity(signal, midpoint),
        pitchDirection: direction,
      };
      segments.push(slide);
    } else {
      // Pitched actors keep ONE freefall arc per gap. For a long gap the full
      // gravity would make the arc rocket up ~0.5*g*dt^2 and plunge, so reduce
      // this segment's gravity to cap the apex (~APEX_MAX_PITCHED for level
      // ends) while still hitting p1 exactly at t1. Short hops keep full gravity
      // because the cap only bites when g*dt^2/8 would exceed the target apex.
      // Rhythm gaps are already subdivided short, so their gravity stays GRAVITY.
      const segmentGravity =
        draft.actor.kind === 'rhythm'
          ? GRAVITY
          : Math.min(GRAVITY, (8 * APEX_MAX_PITCHED) / (duration * duration));
      const ballistic: BallisticSegment = {
        kind: 'ballistic',
        t0: left.timeSec,
        t1: right.timeSec,
        p0: left.position,
        p1: right.position,
        gravity: segmentGravity,
        velocity0: {
          x: (right.position.x - left.position.x) / duration,
          y:
            (right.position.y - left.position.y - 0.5 * segmentGravity * duration * duration) /
            duration,
        },
      };
      segments.push(ballistic);
    }
  }
  return segments;
}

/** Sample a precomputed segment at normalized progress u in [0,1]. */
export function sampleRaceSegment(segment: RaceSegment, uValue: number, out?: Vec2): Vec2 {
  const u = clamp(uValue, 0, 1);
  let x: number;
  let y: number;
  if (segment.kind === 'ballistic') {
    const elapsed = (segment.t1 - segment.t0) * u;
    x = segment.p0.x + segment.velocity0.x * elapsed;
    y = segment.p0.y + segment.velocity0.y * elapsed + 0.5 * segment.gravity * elapsed * elapsed;
  } else {
    const inverse = 1 - u;
    const a = inverse * inverse * inverse;
    const b = 3 * inverse * inverse * u;
    const c = 3 * inverse * u * u;
    const d = u * u * u;
    x = a * segment.p0.x + b * segment.c1.x + c * segment.c2.x + d * segment.p1.x;
    y = a * segment.p0.y + b * segment.c1.y + c * segment.c2.y + d * segment.p1.y;
  }
  if (out) {
    out.x = x;
    out.y = y;
    return out;
  }
  return { x, y };
}

/** World velocity (units/sec) at normalized segment progress. */
export function sampleRaceVelocity(segment: RaceSegment, uValue: number, out?: Vec2): Vec2 {
  const u = clamp(uValue, 0, 1);
  let x: number;
  let y: number;
  if (segment.kind === 'ballistic') {
    const elapsed = (segment.t1 - segment.t0) * u;
    x = segment.velocity0.x;
    y = segment.velocity0.y + segment.gravity * elapsed;
  } else {
    const inverse = 1 - u;
    const duration = Math.max(EXACT_TIME_EPSILON, segment.t1 - segment.t0);
    x =
      (3 * inverse * inverse * (segment.c1.x - segment.p0.x) +
        6 * inverse * u * (segment.c2.x - segment.c1.x) +
        3 * u * u * (segment.p1.x - segment.c2.x)) /
      duration;
    y =
      (3 * inverse * inverse * (segment.c1.y - segment.p0.y) +
        6 * inverse * u * (segment.c2.y - segment.c1.y) +
        3 * u * u * (segment.p1.y - segment.c2.y)) /
      duration;
  }
  if (out) {
    out.x = x;
    out.y = y;
    return out;
  }
  return { x, y };
}

function segmentIndexAt(segments: readonly RaceSegment[], timeSec: number): number {
  if (segments.length === 0) return -1;
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (timeSec <= segments[middle]!.t1) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Closed-form world position for an actor at source-audio time t. */
export function sampleActor(actor: Actor, timeSec: number, out?: Vec2): Vec2 {
  const index = segmentIndexAt(actor.segments, timeSec);
  if (index < 0) {
    const fallback = actor.contacts[0]?.position ?? { x: actor.xBias, y: 0 };
    if (out) {
      out.x = fallback.x;
      out.y = fallback.y;
      return out;
    }
    return { ...fallback };
  }
  const segment = actor.segments[index]!;
  const duration = Math.max(EXACT_TIME_EPSILON, segment.t1 - segment.t0);
  return sampleRaceSegment(segment, (timeSec - segment.t0) / duration, out);
}

export function sampleActorVelocity(actor: Actor, timeSec: number, out?: Vec2): Vec2 {
  const index = segmentIndexAt(actor.segments, timeSec);
  if (index < 0) {
    const fallback = { x: SCROLL_X, y: 0 };
    if (out) {
      out.x = fallback.x;
      out.y = fallback.y;
      return out;
    }
    return fallback;
  }
  const segment = actor.segments[index]!;
  const duration = Math.max(EXACT_TIME_EPSILON, segment.t1 - segment.t0);
  return sampleRaceVelocity(segment, (timeSec - segment.t0) / duration, out);
}

function finishContactGeometry(draft: ActorDraft): void {
  const segmentByStart = new Map<number, RaceSegment>();
  const segmentByEnd = new Map<number, RaceSegment>();
  for (const segment of draft.actor.segments) {
    segmentByStart.set(segment.t0, segment);
    segmentByEnd.set(segment.t1, segment);
  }

  for (let contactIndex = 0; contactIndex < draft.actor.contacts.length; contactIndex += 1) {
    const contact = draft.actor.contacts[contactIndex]!;
    const incomingSegment = segmentByEnd.get(contact.timeSec);
    const outgoingSegment = segmentByStart.get(contact.timeSec);
    const incoming = incomingSegment
      ? sampleRaceVelocity(incomingSegment, 1)
      : outgoingSegment
        ? sampleRaceVelocity(outgoingSegment, 0)
        : { x: SCROLL_X, y: GRAVITY * 0.2 };
    const outgoing = outgoingSegment
      ? sampleRaceVelocity(outgoingSegment, 0)
      : { x: incoming.x, y: incoming.y + GRAVITY * 0.25 };
    const incomingUnit = normalized(incoming);
    const outgoingUnit = normalized(outgoing);

    let normal: Vec2;
    if (incomingSegment?.kind === 'slide' && outgoingSegment?.kind === 'slide') {
      const tangent = normalized({ x: incomingUnit.x + outgoingUnit.x, y: incomingUnit.y + outgoingUnit.y });
      normal = { x: -tangent.y, y: tangent.x };
      if (normal.y < 0) normal = { x: -normal.x, y: -normal.y };
    } else {
      normal = normalized(
        { x: incomingUnit.x - outgoingUnit.x, y: incomingUnit.y - outgoingUnit.y },
        { x: -incomingUnit.y, y: incomingUnit.x },
      );
      if (dot(incoming, normal) < 0) normal = { x: -normal.x, y: -normal.y };
    }
    let tangent = normalized({ x: -normal.y, y: normal.x });
    if (tangent.x < 0) tangent = { x: -tangent.x, y: -tangent.y };

    const incomingSpeed = magnitude(incoming);
    const touchesSlide = incomingSegment?.kind === 'slide' || outgoingSegment?.kind === 'slide';
    const highFall =
      incomingSegment?.kind === 'ballistic' && Math.abs(incoming.y) > SCROLL_X * 1.75;
    // A very steep incoming ballistic is a re-entry dropping in from off-screen
    // after a long silence; it should land in a catch cradle even when the note
    // begins a sustained rail (which would otherwise read as a gentle ramp).
    const steepReentry =
      incomingSegment?.kind === 'ballistic' && Math.abs(incoming.y) > SCROLL_X * 4;
    const style = steepReentry
      ? 'catch'
      : touchesSlide
        ? 'ramp'
        : highFall
          ? 'catch'
          : contact.rapid
            ? 'step'
            : 'kicker';
    contact.normal = normal;
    contact.tangent = tangent;
    contact.surfacePoint = {
      x: contact.position.x + normal.x * BALL_R,
      y: contact.position.y + normal.y * BALL_R,
    };
    contact.incomingSpeed = incomingSpeed;
    contact.style = style;
    const baseLineLength =
      style === 'ramp'
        ? BALL_R * (1.7 + contact.strength)
        : style === 'step'
          ? BALL_R * (2.7 + contact.strength * 1.2)
          : style === 'catch'
            ? BALL_R * (7 + contact.strength * 3)
            : BALL_R * (3.5 + contact.strength * 2.2);
    const previousContact = draft.actor.contacts[contactIndex - 1];
    const nextContact = draft.actor.contacts[contactIndex + 1];
    const nearestGapSec = Math.min(
      previousContact ? contact.timeSec - previousContact.timeSec : Number.POSITIVE_INFINITY,
      nextContact ? nextContact.timeSec - contact.timeSec : Number.POSITIVE_INFINITY,
    );
    const spacingLength = Number.isFinite(nearestGapSec)
      ? Math.max(BALL_R * 0.35, nearestGapSec * SCROLL_X * 0.62)
      : baseLineLength;
    contact.lineLength = style === 'catch' ? baseLineLength : Math.min(baseLineLength, spacingLength);

    const reinforcedRole =
      contact.sourceRoles.includes('bass') || contact.sourceRoles.includes('kick');
    contact.supportLength =
      style === 'catch'
        ? BALL_R * (4.2 + contact.strength * 2.4)
        : style === 'kicker' && reinforcedRole && contact.strength >= 0.75
          ? BALL_R * (1.2 + contact.strength * 1.4)
          : 0;
  }
}

function sceneBounds(actors: readonly Actor[]): { minY: number; maxY: number } {
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const actor of actors) {
    for (const segment of actor.segments) {
      for (const u of [0, 0.25, 0.5, 0.75, 1]) {
        const point = sampleRaceSegment(segment, u);
        minY = Math.min(minY, point.y - BALL_R);
        maxY = Math.max(maxY, point.y + BALL_R);
      }
    }
  }
  return Number.isFinite(minY) ? { minY, maxY } : { minY: -2, maxY: 2 };
}

/**
 * Apply the user's manual vertical offset and tilt to an actor's planned
 * anchors. Implemented as a vertical shear rather than a world-space rotation:
 * y is shifted by `yOffset` plus `tan(rotationDeg) * (x - pivotX)`, and x is
 * left untouched. This is deliberate — the whole pipeline (time->x mapping,
 * camera framing, x-based visibility culling) assumes x == timeSec*SCROLL_X +
 * bias and monotonic. A true rotation would break that and could even reverse
 * x on tall paths. For the near-horizontal race paths a shear is visually
 * indistinguishable from a rotation while keeping every downstream invariant
 * intact. The tilt pivots around the actor's first anchor so a positive angle
 * tilts the far (later) end downward.
 */
function applyActorOverride(draft: ActorDraft, settings: Scene2DSettings): void {
  const override = getActorOverride(settings, draft.actor.id);
  if (override.yOffset === 0 && override.rotationDeg === 0) return;

  const anchors = draft.anchors;
  // Pivot at the MIDDLE of the actor's x-range (symmetric tilt) and CLAMP the
  // shear to +/-MAX_TILT_OFFSET. Without the clamp a tilted actor drifts
  // linearly away from the pack over the whole song, forcing the camera to zoom
  // out; clamped, the tilt is a bounded local lean that becomes a constant
  // offset far from the pivot. x is left untouched (time->x mapping intact).
  const firstX = anchors[0]?.position.x ?? 0;
  const lastX = anchors[anchors.length - 1]?.position.x ?? firstX;
  const pivotX = (firstX + lastX) / 2;
  const slope = Math.tan((override.rotationDeg * Math.PI) / 180);

  for (const anchor of anchors) {
    const shear = clamp((anchor.position.x - pivotX) * slope, -MAX_TILT_OFFSET, MAX_TILT_OFFSET);
    anchor.position.y += override.yOffset + shear;
    if (anchor.contact !== null) anchor.contact.position = anchor.position;
  }
}

/**
 * Insert off-screen exit/re-entry anchors for each long silence, so the ball
 * flies off the screen when its instrument stops and drops back in on the next
 * onset. The off-screen side is chosen from the re-entry note's pitch: a high
 * note re-enters from the top, a low note from the bottom (same side is used
 * for the exit so the ball never crosses the frame mid-silence). The steep
 * re-entry arc makes the landing contact read as a `catch` cradle. The camera
 * ignores the actor during `dormantIntervals`, so it never chases the flight.
 */
function applyLongGapExits(draft: ActorDraft): void {
  if (draft.longGaps.length === 0) return;
  const median = medianPitch(draft.actor.contacts);
  const extra: Anchor[] = [];

  for (const [from, to] of draft.longGaps) {
    const fromAnchor = draft.anchorByContact.get(from);
    const toAnchor = draft.anchorByContact.get(to);
    if (!fromAnchor || !toAnchor) continue;
    const gap = to.timeSec - from.timeSec;
    const exitT = from.timeSec + OFFSCREEN_TRANSIT_SEC;
    const enterT = to.timeSec - OFFSCREEN_TRANSIT_SEC;
    if (enterT <= exitT) continue;
    // -1 = leave/return via the top (high, loud re-entry), +1 = bottom (low).
    const side = to.pitchMidi >= median ? -1 : 1;
    const baseAt = (t: number): number =>
      fromAnchor.position.y +
      ((toAnchor.position.y - fromAnchor.position.y) * (t - from.timeSec)) / gap;
    extra.push({
      timeSec: exitT,
      position: { x: exitT * SCROLL_X + draft.actor.xBias, y: baseAt(exitT) + side * OFFSCREEN_DIST },
      contact: null,
    });
    extra.push({
      timeSec: enterT,
      position: { x: enterT * SCROLL_X + draft.actor.xBias, y: baseAt(enterT) + side * OFFSCREEN_DIST },
      contact: null,
    });
  }

  if (extra.length === 0) return;
  draft.anchors = [...draft.anchors, ...extra].sort((a, b) => a.timeSec - b.timeSec);
}

/** Build the complete immutable race plan once per analysis/settings change. */
export function buildScene2D(
  analysis: AudioAnalysis | null,
  settings: Scene2DSettings,
): Scene2DModel {
  const empty: Scene2DModel = {
    actors: [],
    durationSec: 0,
    ballRadius: BALL_R,
    gravity: GRAVITY,
    bounds: { minY: -2, maxY: 2 },
    sourceHitCount: 0,
    representedHitCount: 0,
    mergeSuggestions: [],
  };
  if (!analysis) return empty;

  const durationSec = Math.max(
    analysis.durationSec,
    ...analysis.hits.map((hit) => hit.startSec),
    0.001,
  );
  const beatSec = beatDuration(analysis);
  const rapidThreshold = beatSec * 0.55;

  // Use custom actor groups from settings, or fall back to one ball per sound.
  const groups: readonly GroupDefinition[] = settings.actorGroups?.length
    ? settings.actorGroups.map((cfg) => ({
        id: cfg.id,
        kind: cfg.kind,
        label: cfg.label,
        color: cfg.color,
        roles: cfg.roles as readonly HitRole[],
      }))
    : DEFAULT_ROLE_ACTORS;

  const candidates = groups.map((definition) => {
    const notes = groupNotes(analysis, definition, settings);
    const signal = buildGroupSignal(analysis, definition.roles, settings);
    return { definition, notes, signal };
  }).filter((candidate) => candidate.notes.length > 0 || hasSignalActivity(candidate.signal));
  if (candidates.length === 0) return empty;

  const supportMargin = Math.max(beatSec, 0.3);
  const prepared = candidates.map((candidate) => {
    const contacts = buildContacts(candidate.notes, candidate.definition.id, rapidThreshold);
    const rawSpans = deriveSupportSpans(
      candidate.signal,
      candidate.definition.kind,
      analysis.sectionCues,
      durationSec,
      beatSec,
    );
    // Drop sustain spans that are pure separation bleed (no onset anywhere in
    // them): a held vocal has onsets, guitar bleeding into the vocal stem does
    // not — this kills the phantom rail during silences.
    const anchoredSpans = rawSpans.filter((s) => spanHasContact(s, contacts, supportMargin));
    // Long silences (the ball will leave the screen across these).
    const longGaps = longSilenceGaps(contacts, anchoredSpans, beatSec);
    // A support span overlapping a long silence is an artifact — remove it so
    // the off-screen flight is clean and the re-entry lands on a bare catch.
    const supportSpans = anchoredSpans.filter(
      (s) => !longGaps.some(([a, b]) => s.startSec < b.timeSec && s.endSec > a.timeSec),
    );
    return {
      ...candidate,
      contacts,
      supportSpans,
      longGaps,
      range: activeRange(contacts, supportSpans),
    };
  }).filter((candidate): candidate is typeof candidate & { range: ActiveRange } => candidate.range !== null);
  if (prepared.length === 0) return empty;

  // Auto vertical layout: order balls by register and space them by amplitude
  // so the scene reads less crowded (replaces uniform lane spacing).
  const laneCenters = computeLaneCenters(
    prepared.map((c) => ({ kind: c.definition.kind, contacts: c.contacts })),
  );

  const drafts: ActorDraft[] = [];
  prepared.forEach((candidate, actorIndex) => {
    const { definition, notes, signal, contacts, supportSpans, longGaps, range } = candidate;
    const xBias = (actorIndex - (prepared.length - 1) / 2) * RACE_X_GAP;
    const sourceRoles = definition.roles.filter(
      (role) =>
        settings.roleVisible[role] &&
        (notes.some((note) => note.role === role) ||
          (trackByRole(analysis).get(role)?.activityQ8.some((value) => value > 0) ?? false)),
    );
    const { anchors, anchorByContact } = createAnchors(
      contacts,
      supportSpans,
      range,
      beatSec,
      definition.kind === 'rhythm',
    );
    planPreliminaryAnchors(
      anchors,
      laneCenters[actorIndex]!,
      xBias,
      definition.kind,
      contacts,
      supportSpans,
      signal,
      analysis.sectionCues,
      beatSec,
      rapidThreshold,
    );
    const actor: Actor = {
      id: definition.id,
      kind: definition.kind,
      color: definition.color,
      label: definition.label,
      sourceRoles,
      xBias,
      contacts,
      segments: [],
      hitTimes: Float64Array.from(contacts, (contact) => contact.timeSec),
      activeStartSec: range.startSec,
      activeEndSec: range.endSec,
      dormantIntervals: longGaps.map(([a, b]) => ({ startSec: a.timeSec, endSec: b.timeSec })),
    };
    drafts.push({
      actor,
      anchors,
      anchorByContact,
      supportSpans,
      signal,
      cues: analysis.sectionCues,
      longGaps,
    });
  });

  const convergences = clusterContacts(drafts, beatSec, analysis.sectionCues);
  applyConvergences(drafts, convergences, durationSec);
  for (const draft of drafts) {
    // Manual override first, then re-clamp rhythm hops so a downward tilt can
    // never re-introduce a sagging arc — the bounce invariant always wins.
    applyActorOverride(draft, settings);
    if (draft.actor.kind === 'rhythm') enforceRhythmHops(draft.anchors);
    else applyLongGapExits(draft);
    draft.actor.segments = buildSegments(draft);
    finishContactGeometry(draft);
  }

  const actors = drafts.map((draft) => draft.actor);
  const sourceHitCount = prepared.reduce((sum, candidate) => sum + candidate.notes.length, 0);
  const representedHitCount = actors.reduce(
    (sum, actor) =>
      sum + actor.contacts.reduce((actorSum, contact) => actorSum + contact.noteIds.length, 0),
    0,
  );

  return {
    actors,
    durationSec,
    ballRadius: BALL_R,
    gravity: GRAVITY,
    bounds: sceneBounds(actors),
    sourceHitCount,
    representedHitCount,
    mergeSuggestions: computeMergeSuggestions(actors, beatSec),
  };
}
