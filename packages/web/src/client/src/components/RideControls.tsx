import { useState } from 'react';
import {
  ACTOR_GROUPS,
  ACTOR_COLOR_PALETTE,
  DEFAULT_ACTOR_OVERRIDE,
  type ActorGroupConfig,
  type ActorOverride,
  type Scene2DSettings,
} from '../scene2d/index.js';
import { ROLE_LABELS } from '../roleMeta.js';
import type { HitRole } from '../App.js';

const ALL_ROLES: readonly HitRole[] = [
  'kick', 'snare', 'percussion', 'bass', 'melodic', 'piano', 'guitar', 'vocal',
];

interface RideControlsProps {
  settings: Scene2DSettings;
  onChange: (next: Scene2DSettings) => void;
}

function effectiveGroups(settings: Scene2DSettings): ActorGroupConfig[] {
  if (settings.actorGroups?.length) return settings.actorGroups;
  return ACTOR_GROUPS.map((g) => ({
    id: g.id,
    kind: g.kind,
    label: g.label,
    color: g.color,
    roles: [...g.roles] as HitRole[],
  }));
}

function getOverride(settings: Scene2DSettings, id: string): ActorOverride {
  return settings.actorOverrides?.[id] ?? DEFAULT_ACTOR_OVERRIDE;
}

/**
 * Full scene controls: configurable actor groups (which roles go into which
 * ball), per-actor Y-offset and rotation sliders, and per-role visibility.
 */
export function RideControls({ settings, onChange }: RideControlsProps) {
  const [editingGroups, setEditingGroups] = useState(false);
  const groups = effectiveGroups(settings);

  // --- Actor group toggle (quick on/off) ---
  const setRoles = (roles: readonly HitRole[], value: boolean): void => {
    const roleVisible = { ...settings.roleVisible };
    for (const role of roles) roleVisible[role] = value;
    onChange({ ...settings, roleVisible });
  };

  // --- Per-actor override ---
  const setOverride = (id: string, patch: Partial<ActorOverride>): void => {
    const current = getOverride(settings, id);
    const next = { ...current, ...patch };
    onChange({
      ...settings,
      actorOverrides: { ...(settings.actorOverrides ?? {}), [id]: next },
    });
  };

  // --- Group editor helpers ---
  const updateGroups = (next: ActorGroupConfig[]): void => {
    onChange({ ...settings, actorGroups: next });
  };

  const addGroup = (): void => {
    const idx = groups.length;
    const color = ACTOR_COLOR_PALETTE[idx % ACTOR_COLOR_PALETTE.length]!;
    updateGroups([
      ...groups,
      { id: `custom-${Date.now()}`, kind: 'lead', label: `Ball ${idx + 1}`, color, roles: [] },
    ]);
  };

  const removeGroup = (id: string): void => {
    updateGroups(groups.filter((g) => g.id !== id));
  };

  const setGroupLabel = (id: string, label: string): void => {
    updateGroups(groups.map((g) => (g.id === id ? { ...g, label } : g)));
  };

  const setGroupColor = (id: string, color: string): void => {
    updateGroups(groups.map((g) => (g.id === id ? { ...g, color } : g)));
  };

  const toggleGroupRole = (groupId: string, role: HitRole): void => {
    updateGroups(
      groups.map((g) => {
        if (g.id !== groupId) {
          // Remove from any other group that has it (one role per ball)
          return { ...g, roles: g.roles.filter((r) => r !== role) };
        }
        const has = g.roles.includes(role);
        return { ...g, roles: has ? g.roles.filter((r) => r !== role) : [...g.roles, role] };
      }),
    );
  };

  const resetGroups = (): void => {
    onChange({ ...settings, actorGroups: undefined, actorOverrides: undefined });
  };

  return (
    <details className="ride-controls" open>
      <summary>Scene controls</summary>
      <div className="ride-controls-body">
        {/* Quick ball toggles + per-actor sliders */}
        <div className="rc-group">
          <span className="rc-label">Balls</span>
          {groups.map((group) => {
            const actorOn = group.roles.some((r) => settings.roleVisible[r]);
            const override = getOverride(settings, group.id);
            return (
              <div className="rc-actor" key={group.id}>
                <button
                  type="button"
                  className={`rc-chip rc-actor-toggle${actorOn ? '' : ' rc-chip-off'}`}
                  onClick={() => setRoles(group.roles, !actorOn)}
                  aria-pressed={actorOn}
                  style={actorOn ? { borderColor: group.color, color: group.color } : undefined}
                >
                  <span className="rc-swatch" style={{ background: group.color }} />
                  {group.label}
                </button>

                {/* Per-actor spatial controls */}
                <div className="rc-overrides">
                  <label className="rc-slider-row">
                    <span className="rc-slider-label">Y offset</span>
                    <input
                      type="range"
                      min={-8}
                      max={8}
                      step={0.1}
                      value={override.yOffset}
                      onChange={(e) => setOverride(group.id, { yOffset: parseFloat(e.target.value) })}
                    />
                    <span className="rc-val">{override.yOffset.toFixed(1)}</span>
                  </label>
                  <label className="rc-slider-row">
                    <span className="rc-slider-label">Rotation</span>
                    <input
                      type="range"
                      min={-15}
                      max={15}
                      step={0.5}
                      value={override.rotationDeg}
                      onChange={(e) => setOverride(group.id, { rotationDeg: parseFloat(e.target.value) })}
                    />
                    <span className="rc-val">{override.rotationDeg.toFixed(1)}&deg;</span>
                  </label>
                </div>
              </div>
            );
          })}
        </div>

        {/* Group editor */}
        <div className="rc-group">
          <button
            type="button"
            className="rc-chip"
            onClick={() => setEditingGroups(!editingGroups)}
          >
            {editingGroups ? 'Done editing' : 'Edit groupings'}
          </button>

          {editingGroups && (
            <div className="rc-editor">
              <p className="rc-hint">
                Assign which instruments go into which ball. A role can only belong to one ball.
              </p>
              {groups.map((group) => (
                <div className="rc-editor-group" key={group.id}>
                  <div className="rc-editor-header">
                    <input
                      className="rc-editor-name"
                      type="text"
                      value={group.label}
                      onChange={(e) => setGroupLabel(group.id, e.target.value)}
                      aria-label="Ball name"
                    />
                    <input
                      type="color"
                      value={group.color}
                      onChange={(e) => setGroupColor(group.id, e.target.value)}
                      className="rc-color-pick"
                      aria-label="Ball color"
                    />
                    <button
                      type="button"
                      className="rc-chip rc-chip-danger"
                      onClick={() => removeGroup(group.id)}
                      aria-label={`Remove ${group.label}`}
                    >
                      &times;
                    </button>
                  </div>
                  <div className="rc-roles">
                    {ALL_ROLES.map((role) => {
                      const inThis = group.roles.includes(role);
                      const inOther = !inThis && groups.some((g) => g.id !== group.id && g.roles.includes(role));
                      return (
                        <button
                          key={role}
                          type="button"
                          className={`rc-chip rc-subchip${inThis ? ' rc-chip-active' : ''}${inOther ? ' rc-chip-dim' : ''}`}
                          onClick={() => toggleGroupRole(group.id, role)}
                          aria-pressed={inThis}
                        >
                          {ROLE_LABELS[role]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="rc-editor-actions">
                <button type="button" className="rc-chip" onClick={addGroup}>
                  + Add ball
                </button>
                <button type="button" className="rc-chip" onClick={resetGroups}>
                  Reset to default
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
