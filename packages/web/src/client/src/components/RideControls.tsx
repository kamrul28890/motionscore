import { ROLE_COLORS, ROLE_LABELS, ROLE_ORDER } from '../roleMeta.js';
import type { Scene2DSettings } from '../scene2d/index.js';

interface RideControlsProps {
  settings: Scene2DSettings;
  onChange: (next: Scene2DSettings) => void;
}

/**
 * Minimal live controls: choose which instruments can appear and cap how many
 * balls show at once (the busiest enabled roles win). Updates the running scene
 * immediately — the parent passes the new settings straight into the model.
 */
export function RideControls({ settings, onChange }: RideControlsProps) {
  const toggleRole = (role: keyof Scene2DSettings['roleVisible']): void => {
    onChange({
      ...settings,
      roleVisible: { ...settings.roleVisible, [role]: !settings.roleVisible[role] },
    });
  };

  return (
    <details className="ride-controls" open>
      <summary>Scene controls</summary>
      <div className="ride-controls-body">
        <div className="rc-group">
          <span className="rc-label">Instruments</span>
          <div className="rc-roles">
            {ROLE_ORDER.map((role) => {
              const on = settings.roleVisible[role];
              return (
                <button
                  key={role}
                  type="button"
                  className={`rc-chip${on ? '' : ' rc-chip-off'}`}
                  onClick={() => toggleRole(role)}
                  aria-pressed={on}
                  style={on ? { borderColor: ROLE_COLORS[role], color: ROLE_COLORS[role] } : undefined}
                >
                  <span className="rc-swatch" style={{ background: ROLE_COLORS[role] }} />
                  {ROLE_LABELS[role]}
                </button>
              );
            })}
          </div>
        </div>

        <label className="rc-slider">
          <span className="rc-label">Max balls</span>
          <input
            type="range"
            min={1}
            max={5}
            step={1}
            value={settings.maxActors}
            onChange={(e) => onChange({ ...settings, maxActors: Number(e.target.value) })}
          />
          <span className="rc-val">{settings.maxActors}</span>
        </label>
      </div>
    </details>
  );
}
