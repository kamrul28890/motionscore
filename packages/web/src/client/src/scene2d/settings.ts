import type { HitRole } from '../renderTypes.js';

/**
 * Minimal, deliberately small settings surface. The v1 aesthetic is strict and
 * deterministic, so the only knobs are which instruments appear and how many
 * balls at once (kept low so the scene never gets overwhelming).
 */
export interface Scene2DSettings {
  /** Per-role opt-in. Combined with `maxActors` to pick the shown balls. */
  roleVisible: Record<HitRole, boolean>;
  /** Hard cap on simultaneous balls (busiest roles win). */
  maxActors: number;
}

export const DEFAULT_SCENE_SETTINGS: Scene2DSettings = {
  roleVisible: {
    kick: true,
    bass: true,
    snare: true,
    percussion: true,
    melodic: true,
    vocal: true,
    piano: true,
    guitar: true,
  },
  maxActors: 3,
};

export function mergeSceneSettings(partial?: Partial<Scene2DSettings>): Scene2DSettings {
  if (!partial) return DEFAULT_SCENE_SETTINGS;
  return {
    ...DEFAULT_SCENE_SETTINGS,
    ...partial,
    roleVisible: { ...DEFAULT_SCENE_SETTINGS.roleVisible, ...(partial.roleVisible ?? {}) },
  };
}
