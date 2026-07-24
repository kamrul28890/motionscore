import type { HitRole } from '../renderTypes.js';
import type { ActorKind } from './types.js';

/** User-configurable ball definition: which roles feed it, its color, label, etc. */
export interface ActorGroupConfig {
  id: string;
  kind: ActorKind;
  label: string;
  color: string;
  roles: HitRole[];
}

/** Per-actor manual spatial override applied after the automatic planner. */
export interface ActorOverride {
  /** Vertical offset in world units (positive = down on screen). */
  yOffset: number;
  /** Rotation of the actor's entire path in degrees (positive = clockwise). */
  rotationDeg: number;
}

/**
 * Complete scene configuration: role visibility, actor grouping, and manual
 * per-actor spatial overrides. Everything is serializable and song-independent.
 */
export interface Scene2DSettings {
  /** Per-source-role opt-in before deterministic actor grouping. */
  roleVisible: Record<HitRole, boolean>;
  /**
   * Custom actor groupings. When present, these replace the default
   * rhythm/bass/lead split. Each group becomes one ball in the scene.
   */
  actorGroups?: ActorGroupConfig[];
  /**
   * Per-actor spatial overrides keyed by actor group `id`. Missing entries
   * default to zero offset and zero rotation.
   */
  actorOverrides?: Record<string, ActorOverride>;
}

/** A palette of colors available for custom actor groups. */
export const ACTOR_COLOR_PALETTE = [
  '#ef476f',
  '#f59f00',
  '#3b82f6',
  '#06d6a0',
  '#8338ec',
  '#ff6b6b',
  '#ffd43b',
  '#a9e34b',
];

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
  // actorGroups and actorOverrides are intentionally absent → use defaults.
};

export function mergeSceneSettings(partial?: Partial<Scene2DSettings>): Scene2DSettings {
  if (!partial) return DEFAULT_SCENE_SETTINGS;
  return {
    ...DEFAULT_SCENE_SETTINGS,
    ...partial,
    roleVisible: { ...DEFAULT_SCENE_SETTINGS.roleVisible, ...(partial.roleVisible ?? {}) },
  };
}

export const DEFAULT_ACTOR_OVERRIDE: ActorOverride = { yOffset: 0, rotationDeg: 0 };

export function getActorOverride(
  settings: Scene2DSettings,
  actorId: string,
): ActorOverride {
  return settings.actorOverrides?.[actorId] ?? DEFAULT_ACTOR_OVERRIDE;
}
