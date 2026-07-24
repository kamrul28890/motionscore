// Project a full AudioAnalysis into the compact, transport-friendly summary the
// web UI displays (role counts, per-role activity strips, a downsampled energy
// timeline, section cues). Kept separate from the analyzer so the summary shape
// can evolve without touching subprocess/validation code.

import {
  ROLE_ACTIVITY_BINS,
  ROLE_ORDER,
  type AudioAnalysis,
  type AudioAnalysisSummary,
  type AudioEnergySample,
  type HitRole,
} from '@motionscore/types';

/** Cap on the downsampled energy timeline points carried in the summary. */
const MAX_ENERGY_SAMPLES = 160;

function emptyRoleRecord<T>(make: () => T): Record<HitRole, T> {
  return {
    kick: make(),
    bass: make(),
    snare: make(),
    percussion: make(),
    melodic: make(),
    vocal: make(),
    piano: make(),
    guitar: make(),
  };
}

/** Project a full {@link AudioAnalysis} into the compact UI-facing summary. */
export function summarizeAnalysis(analysis: AudioAnalysis): AudioAnalysisSummary {
  const roleCounts = emptyRoleRecord<number>(() => 0);
  const roleActivity = emptyRoleRecord<number[]>(() =>
    new Array<number>(ROLE_ACTIVITY_BINS).fill(0),
  );

  // Counts come from exact onsets. Temporal activity comes from the separated
  // waveform (roleSignals), so held vocals/guitar remain visible between attacks.
  for (const hit of analysis.hits) {
    if (hit.role !== undefined) roleCounts[hit.role] += 1;
  }

  if (analysis.roleSignals !== undefined) {
    for (const track of analysis.roleSignals.tracks) {
      const bins = roleActivity[track.role]!;
      const sampleCounts = new Array<number>(ROLE_ACTIVITY_BINS).fill(0);
      const lastFrame = Math.max(1, track.activityQ8.length - 1);
      for (let index = 0; index < track.activityQ8.length; index += 1) {
        const bin = Math.min(
          ROLE_ACTIVITY_BINS - 1,
          Math.floor((index / lastFrame) * ROLE_ACTIVITY_BINS),
        );
        bins[bin]! += track.activityQ8[index]! / 255;
        sampleCounts[bin]! += 1;
      }
      for (let index = 0; index < bins.length; index += 1) {
        if (sampleCounts[index]! > 0) bins[index] = bins[index]! / sampleCounts[index]!;
      }
    }
  }

  // Normalize each role against its own peak bin: the strip reveals an
  // instrument's temporal pattern independent of absolute loudness.
  for (const role of ROLE_ORDER) {
    const bins = roleActivity[role]!;
    let max = 0;
    for (const value of bins) if (value > max) max = value;
    if (max > 0) {
      for (let i = 0; i < bins.length; i += 1) {
        bins[i] = Math.round((bins[i]! / max) * 1000) / 1000;
      }
    }
  }

  return {
    mode: analysis.mode,
    tempoBpm: analysis.tempoBpm,
    durationSec: analysis.durationSec,
    hitCount: analysis.hits.length,
    roleCounts,
    roleActivity,
    sectionCues: analysis.sectionCues,
    energyTimeline: downsampleEnergy(analysis.featureFrames, MAX_ENERGY_SAMPLES),
  };
}

/**
 * Reduce ~10 Hz feature frames to at most `maxSamples` averaged points so the
 * timeline stays compact when serialized. Each point keeps the bucket's mean
 * loudness/bass energy and a representative timestamp.
 */
function downsampleEnergy(
  frames: readonly { timeSec: number; loudness: number; bassEnergy: number }[],
  maxSamples: number,
): AudioEnergySample[] {
  if (frames.length === 0) return [];
  if (frames.length <= maxSamples) {
    return frames.map((frame) => ({
      timeSec: frame.timeSec,
      loudness: frame.loudness,
      bassEnergy: frame.bassEnergy,
    }));
  }

  const bucketSize = frames.length / maxSamples;
  const samples: AudioEnergySample[] = [];
  for (let i = 0; i < maxSamples; i += 1) {
    const start = Math.floor(i * bucketSize);
    const end = Math.min(frames.length, Math.floor((i + 1) * bucketSize));
    let loudness = 0;
    let bassEnergy = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      const frame = frames[j]!;
      loudness += frame.loudness;
      bassEnergy += frame.bassEnergy;
      count += 1;
    }
    if (count === 0) continue;
    const midFrame = frames[Math.min(frames.length - 1, Math.floor((start + end) / 2))]!;
    samples.push({
      timeSec: midFrame.timeSec,
      loudness: loudness / count,
      bassEnergy: bassEnergy / count,
    });
  }
  return samples;
}
