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
import { type Scene2DSettings, type ActorGroupConfig, getActorOverride } from './settings.js';
import type {
  Actor,
  ActorKind,
  BallisticSegment,
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
/** Max deviation (world units) of an unsupported pitched arc from its chord. Bounds silence arcs. */
const MAX_UNSUPPORTED_BULGE = 7;
/** Max |vertical/horizontal| slope allowed between consecutive rhythm contacts (prevents near-vertical "teleport"). */
const RHYTHM_MAX_RISE_SLOPE = 2;
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
  for (const value of signal.activity) if (value > 0) return true;
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

function createAnchors(
  contacts: readonly RaceContact[],
  supportSpans: readonly SupportSpan[],
  durationSec: number,
): { anchors: Anchor[]; anchorByContact: Map<RaceContact, Anchor> } {
  const raw: Array<{ timeSec: number; contact: RaceContact | null }> = [
    { timeSec: 0, contact: null },
    { timeSec: durationSec, contact: null },
  ];
  for (const contact of contacts) raw.push({ timeSec: contact.timeSec, contact });
  for (const span of supportSpans) {
    if (span.startSec > 0 && span.startSec < durationSec) raw.push({ timeSec: span.startSec, contact: null });
    if (span.endSec > 0 && span.endSec < durationSec) raw.push({ timeSec: span.endSec, contact: null });
  }
  raw.sort((a, b) => a.timeSec - b.timeSec || (a.contact ? -1 : 1));

  const anchors: Anchor[] = [];
  const anchorByContact = new Map<RaceContact, Anchor>();
  for (const item of raw) {
    const previous = anchors[anchors.length - 1];
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
    anchors.push(anchor);
    if (item.contact !== null) anchorByContact.set(item.contact, anchor);
  }
  return { anchors, anchorByContact };
}

function planPreliminaryAnchors(
  anchors: Anchor[],
  actorIndex: number,
  actorCount: number,
  xBias: number,
  kind: ActorKind,
  contacts: readonly RaceContact[],
  supportSpans: readonly SupportSpan[],
  signal: GroupSignal,
  cues: readonly SectionCue[],
  beatSec: number,
  rapidThreshold: number,
): void {
  const baseBand = (actorIndex - (actorCount - 1) / 2) * GROUP_GAP;
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
 * Guarantee every rhythm gap is an upward hop AND bound how steeply a contact
 * can sit above the previous one. Under one constant downward gravity the arc
 * between two anchors is fully determined, so it only bounces up when the
 * endpoints do not descend faster than the launch can carry the ball:
 * dy <= 0.5*g*dt^2. Separately, a contact placed far ABOVE the previous one in a
 * short time makes a near-vertical chord that reads as a teleport (the reported
 * percussion jump), so the rise is capped to a maximum slope. Applied after all
 * offsets and convergence so no musical bias, rapid staircase, or crossover can
 * invert a bounce into a sag or produce a vertical jump.
 */
function enforceRhythmHops(anchors: readonly Anchor[]): void {
  const SAFETY = 0.85;
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1]!;
    const current = anchors[index]!;
    const dt = current.timeSec - previous.timeSec;
    if (dt <= EXACT_TIME_EPSILON) continue;
    // Descent clamp: no sag (arc always launches upward).
    const maxY = previous.position.y + 0.5 * GRAVITY * dt * dt * SAFETY;
    if (current.position.y > maxY) current.position.y = maxY;
    // Ascent clamp: a contact cannot rise faster than a bounded slope over the
    // horizontal distance travelled, so no near-vertical "teleport".
    const dx = SCROLL_X * dt;
    const minY = previous.position.y - RHYTHM_MAX_RISE_SLOPE * dx;
    if (current.position.y < minY) current.position.y = minY;
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
      // A parabola's maximum deviation from the straight chord between its two
      // endpoints is exactly gravity*dt^2/8. Bounding that "bulge" keeps a long
      // unsupported gap (a rest) from flying up thousands of units or launching
      // near-vertically: short gaps keep full gravity and stay crisp; long gaps
      // get reduced gravity and become ONE gentle bounded arc (no infinite fall,
      // no bobbing on invisible lines). Rhythm keeps full gravity so its no-sag
      // bounce guarantee (enforceRhythmHops, which assumes GRAVITY) still holds;
      // its steepness is bounded by the ascent clamp there instead.
      const gravity =
        draft.actor.kind === 'rhythm'
          ? GRAVITY
          : Math.min(GRAVITY, (8 * MAX_UNSUPPORTED_BULGE) / (duration * duration));
      const ballistic: BallisticSegment = {
        kind: 'ballistic',
        t0: left.timeSec,
        t1: right.timeSec,
        p0: left.position,
        p1: right.position,
        gravity,
        velocity0: {
          x: (right.position.x - left.position.x) / duration,
          y:
            (right.position.y - left.position.y - 0.5 * gravity * duration * duration) /
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
    const style = touchesSlide
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

  const pivotX = draft.anchors[0]?.position.x ?? 0;
  const slope = Math.tan((override.rotationDeg * Math.PI) / 180);

  for (const anchor of draft.anchors) {
    anchor.position.y += override.yOffset + (anchor.position.x - pivotX) * slope;
    if (anchor.contact !== null) anchor.contact.position = anchor.position;
  }
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
  };
  if (!analysis) return empty;

  const durationSec = Math.max(
    analysis.durationSec,
    ...analysis.hits.map((hit) => hit.startSec),
    0.001,
  );
  const beatSec = beatDuration(analysis);
  const rapidThreshold = beatSec * 0.55;

  // Use custom actor groups from settings, or fall back to the built-in default.
  const groups: readonly GroupDefinition[] = settings.actorGroups?.length
    ? settings.actorGroups.map((cfg) => ({
        id: cfg.id,
        kind: cfg.kind,
        label: cfg.label,
        color: cfg.color,
        roles: cfg.roles as readonly HitRole[],
      }))
    : ACTOR_GROUPS;

  const candidates = groups.map((definition) => {
    const notes = groupNotes(analysis, definition, settings);
    const signal = buildGroupSignal(analysis, definition.roles, settings);
    return { definition, notes, signal };
  }).filter((candidate) => candidate.notes.length > 0 || hasSignalActivity(candidate.signal));
  if (candidates.length === 0) return empty;

  const drafts: ActorDraft[] = [];
  candidates.forEach((candidate, actorIndex) => {
    const { definition, notes, signal } = candidate;
    const xBias = (actorIndex - (candidates.length - 1) / 2) * RACE_X_GAP;
    const contacts = buildContacts(notes, definition.id, rapidThreshold);
    const sourceRoles = definition.roles.filter(
      (role) =>
        settings.roleVisible[role] &&
        (notes.some((note) => note.role === role) ||
          (trackByRole(analysis).get(role)?.activityQ8.some((value) => value > 0) ?? false)),
    );
    const supportSpans = deriveSupportSpans(
      signal,
      definition.kind,
      analysis.sectionCues,
      durationSec,
      beatSec,
    );
    const { anchors, anchorByContact } = createAnchors(contacts, supportSpans, durationSec);
    planPreliminaryAnchors(
      anchors,
      actorIndex,
      candidates.length,
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
    };
    drafts.push({ actor, anchors, anchorByContact, supportSpans, signal, cues: analysis.sectionCues });
  });

  const convergences = clusterContacts(drafts, beatSec, analysis.sectionCues);
  applyConvergences(drafts, convergences, durationSec);
  for (const draft of drafts) {
    // Manual override first, then re-clamp rhythm hops so a downward tilt can
    // never re-introduce a sagging arc — the bounce invariant always wins.
    applyActorOverride(draft, settings);
    if (draft.actor.kind === 'rhythm') enforceRhythmHops(draft.anchors);
    draft.actor.segments = buildSegments(draft);
    finishContactGeometry(draft);
  }

  const actors = drafts.map((draft) => draft.actor);
  const sourceHitCount = candidates.reduce((sum, candidate) => sum + candidate.notes.length, 0);
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
  };
}
