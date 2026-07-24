// Client-side copies of the wire types the real-time renderer consumes.
//
// The web client is a standalone Vite bundle that intentionally does NOT import
// from @motionscore/types (that package is server/build-side). These mirror the
// relevant contract shapes returned by GET /api/result/:jobId. Keep in sync with
// packages/types/src/data-contracts.ts.

export type HitRole =
  | 'kick'
  | 'bass'
  | 'snare'
  | 'percussion'
  | 'melodic'
  | 'vocal'
  | 'piano'
  | 'guitar';

/** A single hittable musical event (audio attack). */
export interface NoteEvent {
  id: string;
  pitchMidi: number;
  startSec: number;
  endSec: number;
  velocity: number;
  source?: 'audio';
  role?: HitRole;
  confidence?: number;
  salience?: number;
  track?: string;
  instrument?: string;
}

/** Continuous normalized audio features sampled at ~10 Hz. */
export interface AudioFeatureFrame {
  timeSec: number;
  loudness: number;
  bassEnergy: number;
  brightness: number;
  onsetDensity: number;
  harmonicEnergy: number;
  percussiveEnergy: number;
}

export type PitchDirection = -1 | 0 | 1;
export type SustainSpan = [startFrame: number, endFrame: number];

export interface RoleSignalTrack {
  role: HitRole;
  activityQ8: number[];
  sustainSpans: SustainSpan[];
  pitchDirection?: PitchDirection[];
  pitchCoverageQ8?: number;
}

export interface RoleSignals {
  version: 1;
  frameRateHz: number;
  frameCount: number;
  tracks: RoleSignalTrack[];
}

export interface SectionCue {
  type: 'build' | 'drop' | 'breakdown' | 'rise' | 'fall';
  startSec: number;
  endSec: number;
  peakSec?: number;
  intensity: number;
  confidence: number;
}

/** Full rich analysis (neural per-instrument stems). */
export interface AudioAnalysis {
  version: 1;
  durationSec: number;
  tempoBpm: number;
  mode: 'stems';
  hits: NoteEvent[];
  featureFrames: AudioFeatureFrame[];
  sectionCues: SectionCue[];
  roleSignals?: RoleSignals;
}

/** One separately-playable Demucs stem, for the in-browser mute/solo mixer. */
export interface StemTrack {
  id: string;
  label: string;
  url: string;
}

/** Response body of GET /api/result/:jobId. */
export interface ResultPayload {
  durationSec: number;
  audioUrl: string;
  analysis: AudioAnalysis | null;
  /** Present when the analyzer exported per-instrument stems (mixer feature). */
  stems?: StemTrack[];
}
