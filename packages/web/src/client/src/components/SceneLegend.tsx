import type { CSSProperties } from 'react';
import type { Actor } from '../scene2d/index.js';
import type { AudioAnalysis, HitRole } from '../renderTypes.js';
import { ROLE_LABELS } from '../roleMeta.js';
import { roleStateAt } from '../visualization-state.js';

interface SceneLegendProps {
  actors: readonly Actor[];
  analysis: AudioAnalysis;
  timeSec: number;
  selectedRole: HitRole | null;
  onSelectRole: (role: HitRole | null) => void;
  onHoverRole: (role: HitRole | null) => void;
}

export function SceneLegend({
  actors,
  analysis,
  timeSec,
  selectedRole,
  onSelectRole,
  onHoverRole,
}: SceneLegendProps) {
  const roles = actors.flatMap((actor) =>
    actor.sourceRoles.map((role) => ({ role, actor })),
  );
  const unique = roles.filter(
    (entry, index) => roles.findIndex((candidate) => candidate.role === entry.role) === index,
  );

  return (
    <div className="scene-legend" aria-label="Live instrument legend">
      {unique.map(({ role, actor }) => {
        const status = roleStateAt(analysis, role, timeSec);
        const selected = selectedRole === role;
        return (
          <button
            key={role}
            type="button"
            className={`scene-legend-item${selected ? ' scene-legend-item-active' : ''}`}
            aria-pressed={selected}
            onClick={() => onSelectRole(selected ? null : role)}
            onMouseEnter={() => onHoverRole(role)}
            onMouseLeave={() => onHoverRole(null)}
          >
            <span className="scene-legend-swatch" style={{ backgroundColor: actor.color }} />
            <span className="scene-legend-copy">
              <b>{ROLE_LABELS[role]}</b>
              <small>{status.state}</small>
            </span>
            <span
              className="scene-legend-meter"
              style={{ '--role-activity': `${Math.round(status.activity * 100)}%` } as CSSProperties}
              aria-label={`${Math.round(status.activity * 100)}% activity`}
            />
          </button>
        );
      })}
    </div>
  );
}
