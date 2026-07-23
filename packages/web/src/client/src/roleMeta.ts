import type { HitRole } from './App.js';

// Role display metadata for the analysis UI.
//
// These values MUST match `ROLE_COLORS` / `ROLE_LABELS` / `ROLE_ORDER` in
// `@motionscore/types` (data-contracts.ts). The web client is a standalone Vite
// bundle that mirrors the wire contract locally rather than importing the
// workspace package at runtime, so the palette is duplicated here on purpose.
// Keeping the hex values identical means a role's legend swatch matches the tint
// of its ball in the rendered video.

/** Canonical display order: percussion cluster first, then pitched instruments. */
export const ROLE_ORDER: readonly HitRole[] = [
  'kick',
  'snare',
  'percussion',
  'bass',
  'melodic',
  'piano',
  'guitar',
  'vocal',
];

/** Ball tint per role (matches the mapper's per-role `colorHint`). */
export const ROLE_COLORS: Record<HitRole, string> = {
  kick: '#ff6b6b',
  bass: '#ffa94d',
  snare: '#ffd43b',
  percussion: '#63e6be',
  melodic: '#4dabf7',
  piano: '#b197fc',
  guitar: '#f783ac',
  vocal: '#a9e34b',
};

/** Human-friendly instrument label per role. */
export const ROLE_LABELS: Record<HitRole, string> = {
  kick: 'Kick',
  bass: 'Bass',
  snare: 'Snare',
  percussion: 'Percussion',
  melodic: 'Melody',
  piano: 'Piano',
  guitar: 'Guitar',
  vocal: 'Vocals',
};
