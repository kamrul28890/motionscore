import { useState } from 'react';
import {
  DEFAULT_ROLE_ACTORS,
  DEFAULT_ACTOR_OVERRIDE,
  type ActorGroupConfig,
  type ActorOverride,
  type Scene2DSettings,
} from '../scene2d/index.js';
import { ROLE_COLORS, ROLE_LABELS } from '../roleMeta.js';
import type { HitRole } from '../App.js';
import type { ActorKind } from '../scene2d/index.js';

interface RideControlsProps {
  settings: Scene2DSettings;
  onChange: (next: Scene2DSettings) => void;
}

const LEAD_ROLES: ReadonlySet<HitRole> = new Set(['melodic', 'piano', 'guitar', 'vocal']);

/** Physics family for a ball from the sounds it contains (matches the planner). */
function kindForRoles(roles: readonly HitRole[]): ActorKind {
  if (roles.some((r) => LEAD_ROLES.has(r))) return 'lead';
  if (roles.includes('bass')) return 'bass';
  return 'rhythm';
}

/** The current groups: custom if set, otherwise the one-ball-per-sound default. */
function effectiveGroups(settings: Scene2DSettings): ActorGroupConfig[] {
  const source = settings.actorGroups?.length ? settings.actorGroups : DEFAULT_ROLE_ACTORS;
  return source.map((g) => ({
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
 * Scene controls. Default is one ball per sound (named/coloured by the sound).
 * Drag a sound chip from one ball into another ball's box to group them, or onto
 * the "New ball" zone to split it out. Each ball also has show/hide and manual
 * vertical-offset / rotation.
 */
export function RideControls({ settings, onChange }: RideControlsProps) {
  const [dragRole, setDragRole] = useState<HitRole | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const groups = effectiveGroups(settings);

  const updateGroups = (next: ActorGroupConfig[]): void => {
    // Drop empty balls and keep kinds in sync with their contents.
    const cleaned = next
      .filter((g) => g.roles.length > 0)
      .map((g) => ({ ...g, kind: kindForRoles(g.roles) }));
    onChange({ ...settings, actorGroups: cleaned });
  };

  const setRolesVisible = (roles: readonly HitRole[], value: boolean): void => {
    const roleVisible = { ...settings.roleVisible };
    for (const role of roles) roleVisible[role] = value;
    onChange({ ...settings, roleVisible });
  };

  const setOverride = (id: string, patch: Partial<ActorOverride>): void => {
    const current = getOverride(settings, id);
    onChange({
      ...settings,
      actorOverrides: { ...(settings.actorOverrides ?? {}), [id]: { ...current, ...patch } },
    });
  };

  const setLabel = (id: string, label: string): void =>
    updateGroups(groups.map((g) => (g.id === id ? { ...g, label } : g)));
  const setColor = (id: string, color: string): void =>
    updateGroups(groups.map((g) => (g.id === id ? { ...g, color } : g)));

  const moveRoleToGroup = (role: HitRole, targetId: string): void => {
    const stripped = groups.map((g) => ({ ...g, roles: g.roles.filter((r) => r !== role) }));
    updateGroups(
      stripped.map((g) => (g.id === targetId ? { ...g, roles: [...g.roles, role] } : g)),
    );
  };

  const moveRoleToNewBall = (role: HitRole): void => {
    const stripped = groups.map((g) => ({ ...g, roles: g.roles.filter((r) => r !== role) }));
    stripped.push({
      id: `ball-${role}-${Date.now()}`,
      kind: kindForRoles([role]),
      label: ROLE_LABELS[role],
      color: ROLE_COLORS[role],
      roles: [role],
    });
    updateGroups(stripped);
  };

  const resetToDefault = (): void =>
    onChange({ ...settings, actorGroups: undefined, actorOverrides: undefined });

  const handleDrop = (targetId: string | 'new'): void => {
    if (!dragRole) return;
    if (targetId === 'new') moveRoleToNewBall(dragRole);
    else moveRoleToGroup(dragRole, targetId);
    setDragRole(null);
    setDropTarget(null);
  };

  return (
    <details className="ride-controls" open>
      <summary>Scene controls</summary>
      <div className="ride-controls-body">
        <p className="rc-hint">
          One ball per sound. Drag a sound into another ball to group them, or onto
          &ldquo;New ball&rdquo; to split it out. Toggle a ball to show/hide it.
        </p>

        <div className="rc-balls">
          {groups.map((group) => {
            const actorOn = group.roles.some((r) => settings.roleVisible[r]);
            const override = getOverride(settings, group.id);
            return (
              <div
                key={group.id}
                className={`rc-ball${dropTarget === group.id ? ' rc-ball-drop' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dropTarget !== group.id) setDropTarget(group.id);
                }}
                onDragLeave={() => setDropTarget((cur) => (cur === group.id ? null : cur))}
                onDrop={() => handleDrop(group.id)}
              >
                <div className="rc-ball-head">
                  <span className="rc-swatch" style={{ background: group.color }} />
                  <input
                    className="rc-ball-name"
                    type="text"
                    value={group.label}
                    onChange={(e) => setLabel(group.id, e.target.value)}
                    aria-label="Ball name"
                  />
                  <input
                    type="color"
                    className="rc-color-pick"
                    value={group.color}
                    onChange={(e) => setColor(group.id, e.target.value)}
                    aria-label="Ball colour"
                  />
                  <button
                    type="button"
                    className={`rc-eye${actorOn ? '' : ' rc-eye-off'}`}
                    onClick={() => setRolesVisible(group.roles, !actorOn)}
                    aria-pressed={actorOn}
                    title={actorOn ? 'Hide ball' : 'Show ball'}
                  >
                    {actorOn ? 'shown' : 'hidden'}
                  </button>
                </div>

                <div className="rc-ball-roles">
                  {group.roles.map((role) => (
                    <span
                      key={role}
                      className="rc-chip rc-role-chip"
                      draggable
                      onDragStart={() => setDragRole(role)}
                      onDragEnd={() => { setDragRole(null); setDropTarget(null); }}
                      style={{ borderColor: ROLE_COLORS[role] }}
                    >
                      <span className="rc-swatch rc-swatch-sm" style={{ background: ROLE_COLORS[role] }} />
                      {ROLE_LABELS[role]}
                    </span>
                  ))}
                </div>

                <div className="rc-overrides">
                  <label className="rc-slider-row">
                    <span className="rc-slider-label">Height</span>
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
                    <span className="rc-slider-label">Tilt</span>
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

          <div
            className={`rc-new-ball${dropTarget === 'new' ? ' rc-ball-drop' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (dropTarget !== 'new') setDropTarget('new');
            }}
            onDragLeave={() => setDropTarget((cur) => (cur === 'new' ? null : cur))}
            onDrop={() => handleDrop('new')}
          >
            + New ball (drop a sound here)
          </div>
        </div>

        <button type="button" className="rc-chip rc-reset" onClick={resetToDefault}>
          Reset to one ball per sound
        </button>
      </div>
    </details>
  );
}
