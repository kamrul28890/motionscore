import type { AudioAnalysis, HitRole } from '../renderTypes.js';
import { ROLE_COLORS, ROLE_LABELS } from '../roleMeta.js';

const CUE_COLORS = {
  drop: '#ff4466',
  build: '#4477ff',
  rise: '#22b8cf',
  fall: '#9775fa',
  breakdown: '#748ffc',
} as const;

interface SongMinimapProps {
  analysis: AudioAnalysis;
  roles: readonly HitRole[];
  timeSec: number;
  onSeek: (timeSec: number) => void;
}

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function SongMinimap({ analysis, roles, timeSec, onSeek }: SongMinimapProps) {
  const duration = Math.max(0.001, analysis.durationSec);

  return (
    <div className="song-map-block">
      <div className="song-map-header">
        <span>Musical map</span>
        <small>
          {formatTime(timeSec)} / {formatTime(duration)} · click or use arrow keys to seek
        </small>
      </div>
      <div className="song-map">
        <svg viewBox={`0 0 1000 ${Math.max(48, roles.length * 12 + 24)}`} preserveAspectRatio="none">
          <title>Full-song map of sections, instrument activity, hits, and playhead</title>
          <desc>Colored section bands sit behind one activity lane per visible instrument.</desc>
          {analysis.sectionCues.map((cue, index) => (
            <rect
              key={`cue-${index}`}
              x={(cue.startSec / duration) * 1000}
              y={0}
              width={Math.max(1, ((cue.endSec - cue.startSec) / duration) * 1000)}
              height="100%"
              fill={CUE_COLORS[cue.type]}
              opacity={0.13 + cue.intensity * 0.12}
            />
          ))}
          {roles.map((role, roleIndex) => {
            const y = 17 + roleIndex * 12;
            const track = analysis.roleSignals?.tracks.find((candidate) => candidate.role === role);
            const values = track?.activityQ8 ?? [];
            const stride = Math.max(1, Math.ceil(values.length / 480));
            const bins = Array.from(
              { length: Math.ceil(values.length / stride) },
              (_, index) =>
                Math.max(...values.slice(index * stride, (index + 1) * stride), 0),
            );
            const step = bins.length > 0 ? 1000 / bins.length : 1000;
            return (
              <g key={role}>
                <line x1={0} y1={y} x2={1000} y2={y} stroke="rgba(21,21,21,0.12)" strokeWidth={1} />
                {bins.map((value, index) =>
                  value > 24 ? (
                    <rect
                      key={index}
                      x={index * step}
                      y={y - (value / 255) * 4}
                      width={Math.max(0.7, step)}
                      height={Math.max(1, (value / 255) * 8)}
                      fill={ROLE_COLORS[role]}
                      opacity={0.35 + (value / 255) * 0.65}
                    />
                  ) : null,
                )}
                {analysis.hits
                  .filter((hit) => hit.role === role)
                  .map((hit) => (
                    <circle
                      key={hit.id}
                      cx={(hit.startSec / duration) * 1000}
                      cy={y}
                      r={Math.max(1.3, (hit.salience ?? hit.velocity) * 2.2)}
                      fill={ROLE_COLORS[role]}
                    />
                  ))}
              </g>
            );
          })}
          <line
            x1={(Math.min(duration, Math.max(0, timeSec)) / duration) * 1000}
            y1={0}
            x2={(Math.min(duration, Math.max(0, timeSec)) / duration) * 1000}
            y2="100%"
            stroke="#151515"
            strokeWidth={3}
          />
        </svg>
        <input
          className="song-map-range"
          type="range"
          min={0}
          max={duration}
          step={0.1}
          value={Math.min(duration, Math.max(0, timeSec))}
          aria-label="Song position and musical activity"
          aria-valuetext={`${formatTime(timeSec)} of ${formatTime(duration)}`}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
      </div>
      <div className="song-map-key" aria-label="Map legend">
        <span><i className="song-map-key-line" /> playhead</span>
        <span><i className="song-map-key-dot" /> detected hit</span>
        <span><i className="song-map-key-band" /> section</span>
        <span className="song-map-role-labels">
          {roles.map((role) => ROLE_LABELS[role]).join(' · ')}
        </span>
      </div>
    </div>
  );
}
