import { useEffect, useState } from 'react';
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

interface EncoderInfo {
  id: string;
  label: string;
}

const PRESETS: Preset[] = [
  { label: '1080p 60fps', width: 1920, height: 1080, fps: 60 },
  { label: '720p 30fps', width: 1280, height: 720, fps: 30 },
  { label: '4K 60fps', width: 3840, height: 2160, fps: 60 },
];

export function ConfigForm({ options, onChange, onGenerate, disabled, canGenerate }: ConfigFormProps) {
  const [encoders, setEncoders] = useState<EncoderInfo[]>([{ id: 'libx264', label: 'CPU (libx264)' }]);

  useEffect(() => {
    fetch('/api/encoders')
      .then((res) => res.json())
      .then((data: EncoderInfo[]) => {
        if (Array.isArray(data) && data.length > 0) {
          setEncoders(data);
        }
      })
      .catch(() => {});
  }, []);

  const update = (patch: Partial<GenerateOptions>) => {
    onChange({ ...options, ...patch });
  };

  const applyPreset = (preset: Preset) => {
    update({ width: preset.width, height: preset.height, fps: preset.fps });
  };

  const isGpuEncoder = options.codec !== 'libx264';

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

      <label className="form-field form-field-wide">
        <span className="form-label">What the ball hits</span>
        <select
          value={options.mode}
          onChange={(e) => update({ mode: e.target.value as GenerateOptions['mode'] })}
          disabled={disabled}
        >
          <option value="auto">Auto — smart instrument-aware hits (recommended)</option>
          <option value="beats">Beats — metrical pulse (can miss fills)</option>
          <option value="onsets">Onsets — all full-mix attacks</option>
          <option value="notes">Notes — full transcription (most hits)</option>
        </select>
        <span className="form-hint">
          Auto separates harmonic/percussive frequency layers, keeps salient attacks,
          and merges simultaneous hits. MIDI files always use their original notes.
        </span>
      </label>

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

      <h3 className="section-title">Performance</h3>

      <div className="form-grid">
        <label className="form-field">
          <span className="form-label">Encoder</span>
          <select
            value={options.codec}
            onChange={(e) => update({ codec: e.target.value })}
            disabled={disabled}
          >
            {encoders.map((enc) => (
              <option key={enc.id} value={enc.id}>{enc.label}</option>
            ))}
          </select>
        </label>

        {isGpuEncoder && (
          <label className="form-field">
            <span className="form-label">GPU Device</span>
            <select
              value={options.gpuDevice}
              onChange={(e) => update({ gpuDevice: Number(e.target.value) })}
              disabled={disabled}
            >
              <option value={0}>GPU 0 (Primary)</option>
              <option value={1}>GPU 1 (External/Secondary)</option>
              <option value={2}>GPU 2</option>
            </select>
          </label>
        )}

        {isGpuEncoder && options.codec === 'h264_nvenc' && (
          <label className="form-field">
            <span className="form-label">NVENC Preset</span>
            <select
              value={options.preset || 'p4'}
              onChange={(e) => update({ preset: e.target.value })}
              disabled={disabled}
            >
              <option value="p1">P1 (Fastest)</option>
              <option value="p2">P2</option>
              <option value="p3">P3</option>
              <option value="p4">P4 (Balanced)</option>
              <option value="p5">P5</option>
              <option value="p6">P6</option>
              <option value="p7">P7 (Best Quality)</option>
            </select>
          </label>
        )}

        {isGpuEncoder && options.codec === 'h264_amf' && (
          <label className="form-field">
            <span className="form-label">AMF Quality</span>
            <select
              value={options.preset || 'balanced'}
              onChange={(e) => update({ preset: e.target.value })}
              disabled={disabled}
            >
              <option value="speed">Speed</option>
              <option value="balanced">Balanced</option>
              <option value="quality">Quality</option>
            </select>
          </label>
        )}

        {!isGpuEncoder && (
          <label className="form-field">
            <span className="form-label">x264 Preset</span>
            <select
              value={options.preset || 'medium'}
              onChange={(e) => update({ preset: e.target.value })}
              disabled={disabled}
            >
              <option value="ultrafast">Ultrafast</option>
              <option value="superfast">Superfast</option>
              <option value="veryfast">Very Fast</option>
              <option value="faster">Faster</option>
              <option value="fast">Fast</option>
              <option value="medium">Medium</option>
              <option value="slow">Slow</option>
              <option value="slower">Slower</option>
              <option value="veryslow">Very Slow</option>
            </select>
          </label>
        )}

        <label className="form-field">
          <span className="form-label">Parallel Frames</span>
          <input
            type="number"
            min={1}
            max={16}
            value={options.parallelFrames}
            onChange={(e) => update({ parallelFrames: Math.max(1, Math.min(16, Number(e.target.value) || 4)) })}
            disabled={disabled}
          />
          <span className="form-hint">CPU cores for rendering</span>
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
