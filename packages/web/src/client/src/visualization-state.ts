import type {
  AudioAnalysis,
  HitRole,
  RoleSignalTrack,
  SectionCue,
  StemTrack,
} from './renderTypes.js';
import { ROLE_LABELS } from './roleMeta.js';

export type SceneRoleState = 'HIT' | 'RISING' | 'FALLING' | 'SUSTAIN' | 'ACTIVE' | 'QUIET';

export const STEM_ROLES: Record<string, readonly HitRole[]> = {
  drums: ['kick', 'snare', 'percussion'],
  bass: ['bass'],
  vocals: ['vocal'],
  guitar: ['guitar'],
  piano: ['piano'],
  other: ['melodic'],
};

export function stemForRole(role: HitRole, stems: readonly StemTrack[]): string | null {
  return (
    stems.find((stem) => (STEM_ROLES[stem.id] ?? []).includes(role))?.id ?? null
  );
}

export function rolesForStem(stemId: string): readonly HitRole[] {
  return STEM_ROLES[stemId] ?? [];
}

export function sectionAt(
  cues: readonly SectionCue[],
  timeSec: number,
): SectionCue | null {
  let best: SectionCue | null = null;
  for (const cue of cues) {
    if (timeSec < cue.startSec || timeSec > cue.endSec) continue;
    if (!best || cue.intensity * cue.confidence > best.intensity * best.confidence) best = cue;
  }
  return best;
}

function signalAt(track: RoleSignalTrack | undefined, frameRateHz: number, timeSec: number) {
  if (!track || track.activityQ8.length === 0) {
    return { activity: 0, direction: 0 as -1 | 0 | 1, sustained: false };
  }
  const index = Math.max(
    0,
    Math.min(track.activityQ8.length - 1, Math.floor(timeSec * Math.max(1, frameRateHz))),
  );
  const sustained = track.sustainSpans.some(([start, end]) => index >= start && index <= end);
  return {
    activity: (track.activityQ8[index] ?? 0) / 255,
    direction: track.pitchDirection?.[index] ?? 0,
    sustained,
  };
}

export function roleStateAt(
  analysis: AudioAnalysis,
  role: HitRole,
  timeSec: number,
): { state: SceneRoleState; activity: number } {
  const hit = analysis.hits.some(
    (event) => event.role === role && Math.abs(event.startSec - timeSec) <= 0.11,
  );
  const track = analysis.roleSignals?.tracks.find((candidate) => candidate.role === role);
  const signal = signalAt(track, analysis.roleSignals?.frameRateHz ?? 10, timeSec);
  if (hit) return { state: 'HIT', activity: Math.max(signal.activity, 0.9) };
  if (signal.activity < 0.12) return { state: 'QUIET', activity: signal.activity };
  if (signal.direction > 0 && signal.activity >= 0.28) {
    return { state: 'RISING', activity: signal.activity };
  }
  if (signal.direction < 0 && signal.activity >= 0.28) {
    return { state: 'FALLING', activity: signal.activity };
  }
  if (signal.sustained) return { state: 'SUSTAIN', activity: signal.activity };
  return { state: 'ACTIVE', activity: signal.activity };
}

export function describeScene(
  analysis: AudioAnalysis,
  roles: readonly HitRole[],
  timeSec: number,
): string {
  const section = sectionAt(analysis.sectionCues, timeSec);
  const states = roles.map((role) => ({ role, ...roleStateAt(analysis, role, timeSec) }));
  const active = states.filter((entry) => entry.state !== 'QUIET');
  const activity =
    active.length === 0
      ? 'All visible instruments are quiet.'
      : active
          .map((entry) => `${ROLE_LABELS[entry.role]} ${entry.state.toLowerCase()}`)
          .join(', ') + '.';
  const structure = section
    ? `${section.type} section at ${Math.round(section.intensity * 100)}% intensity.`
    : 'No strong structural section is active.';
  return `${structure} ${activity}`;
}

