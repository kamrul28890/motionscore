import type { GenerateOptions } from '../App.js';

interface ConfigFormProps {
  options: GenerateOptions;
  onChange: (options: GenerateOptions) => void;
  onGenerate: () => void;
  disabled: boolean;
  canGenerate: boolean;
}

interface Preset {
  label: string;
  width: number;
  height: number;
  fps: number;
}

const PRESETS: Preset[] = [
  { label: '1080p 60fps', width: 1920, height: 1080, fps: 60 },
  { label: '720p 30fps', width: 1280, height: 720, fps: 30 },
  { label: '4K 60fps', width: 3840, height: 2160, fps: 60 },
];

export function ConfigForm({ options, onChange, onGenerate, disabled, canGenerate }: ConfigFormProps) {
  const update = (patch: Partial<GenerateOptions>) => {
    onChange({ ...options, ...patch });
  };

  const applyPreset = (preset: Preset) => {
    update({ width: preset.width, height: preset.height, fps: preset.fps });
  };

  return (
    <div className="card">
      <h2>Settings</h2>

      <div className="presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            className={`btn btn-preset ${
              options.width === preset.width &&
              options.height === preset.height &&
              options.fps === preset.fps
                ? 'active'
                : ''
            }`}
            onClick={() => applyPreset(preset)}
            disabled={disabled}
            type="button"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="form-grid">
        <label className="form-field">
          <span className="form-label">FPS</span>
          <input
            type="number"
            min={1}
            max={120}
            value={options.fps}
            onChange={(e) => update({ fps: Math.max(1, Math.min(120, Number(e.target.value) || 60)) })}
            disabled={disabled}
          />
        </label>

        <label className="form-field">
          <span className="form-label">Width</span>
          <input
            type="number"
            min={100}
            max={3840}
            value={options.width}
            onChange={(e) => update({ width: Math.max(100, Math.min(3840, Number(e.target.value) || 1920)) })}
            disabled={disabled}
          />
        </label>

        <label className="form-field">
          <span className="form-label">Height</span>
          <input
            type="number"
            min={100}
            max={2160}
            value={options.height}
            onChange={(e) => update({ height: Math.max(100, Math.min(2160, Number(e.target.value) || 1080)) })}
            disabled={disabled}
          />
        </label>

        <label className="form-field">
          <span className="form-label">Layout</span>
          <select
            value={options.layout}
            onChange={(e) => update({ layout: e.target.value as 'piano-keys' | 'lanes' })}
            disabled={disabled}
          >
            <option value="piano-keys">Piano Keys</option>
            <option value="lanes">Lanes</option>
          </select>
        </label>
      </div>

      <button
        className="btn btn-primary btn-generate"
        onClick={onGenerate}
        disabled={disabled || !canGenerate}
        type="button"
      >
        {disabled ? 'Generating...' : 'Generate Video'}
      </button>
    </div>
  );
}
