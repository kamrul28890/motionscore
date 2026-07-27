import type { AudioAnalysisSummary, SectionCue } from '../App.js';
import type { StemTrack } from '../renderTypes.js';
import { ROLE_COLORS, ROLE_LABELS, ROLE_ORDER } from '../roleMeta.js';
import { stemForRole } from '../visualization-state.js';

interface AnalysisPanelProps {
  analysis: AudioAnalysisSummary;
  stems: StemTrack[];
  enabledStemIds: readonly string[];
  onStemEnabledChange: (stemId: string, enabled: boolean) => void;
}

/** Colors per structural cue type, ordered from high-energy to low-energy. */
const CUE_COLORS: Record<SectionCue['type'], string> = {
  drop: '#ff4466',
  build: '#4477ff',
  rise: '#22b8cf',
  fall: '#9775fa',
  breakdown: '#748ffc',
};

const MODE_LABELS: Record<AudioAnalysisSummary['mode'], string> = {
  stems: 'Stems (neural per-instrument)',
};

const SPARK_WIDTH = 1000;
const SPARK_HEIGHT = 120;

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Build an SVG polyline point string for a [0,1]-valued series over time. */
function toPoints(
  samples: readonly { timeSec: number; value: number }[],
  durationSec: number,
): string {
  if (samples.length === 0 || durationSec <= 0) return '';
  return samples
    .map((sample) => {
      const x = (Math.min(sample.timeSec, durationSec) / durationSec) * SPARK_WIDTH;
      const y = SPARK_HEIGHT - Math.max(0, Math.min(1, sample.value)) * SPARK_HEIGHT;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function AnalysisPanel({
  analysis,
  stems,
  enabledStemIds,
  onStemEnabledChange,
}: AnalysisPanelProps) {
  const { durationSec, energyTimeline, sectionCues } = analysis;
  const activeRoles = ROLE_ORDER.filter((role) => analysis.roleCounts[role] > 0);

  const loudnessPoints = toPoints(
    energyTimeline.map((s) => ({ timeSec: s.timeSec, value: s.loudness })),
    durationSec,
  );
  const bassPoints = toPoints(
    energyTimeline.map((s) => ({ timeSec: s.timeSec, value: s.bassEnergy })),
    durationSec,
  );
  const loudnessArea =
    loudnessPoints.length > 0
      ? `0,${SPARK_HEIGHT} ${loudnessPoints} ${SPARK_WIDTH},${SPARK_HEIGHT}`
      : '';

  const xFor = (timeSec: number): number =>
    durationSec > 0 ? (Math.min(timeSec, durationSec) / durationSec) * SPARK_WIDTH : 0;

  return (
    <div className="card analysis-card">
      <div className="card-head">
        <h2>Music analysis</h2>
        <span className="analysis-mode" title="Extraction mode">{MODE_LABELS[analysis.mode]}</span>
      </div>

      <div className="analysis-summary">
        <div className="stat">
          <span className="stat-value">{analysis.tempoBpm > 0 ? analysis.tempoBpm.toFixed(0) : '—'}</span>
          <span className="stat-label">BPM</span>
        </div>
        <div className="stat">
          <span className="stat-value">{formatTime(durationSec)}</span>
          <span className="stat-label">Duration</span>
        </div>
        <div className="stat">
          <span className="stat-value">{analysis.hitCount}</span>
          <span className="stat-label">Ball hits</span>
        </div>
        <div className="stat">
          <span className="stat-value">{sectionCues.length}</span>
          <span className="stat-label">Section cues</span>
        </div>
      </div>

      {activeRoles.length > 0 && (
        <div className="analysis-block">
          <div className="analysis-subtitle-row">
            <h3 className="analysis-subtitle">Instruments over time</h3>
            <span>Tick instruments to build a shared karaoke mix</span>
          </div>
          <div className="role-activity">
            {activeRoles.map((role) => {
              const activity = analysis.roleActivity?.[role] ?? [];
              const color = ROLE_COLORS[role];
              const bins = Math.max(1, activity.length);
              const stemId = stemForRole(role, stems);
              const stem = stems.find((candidate) => candidate.id === stemId);
              const included = stemId ? enabledStemIds.includes(stemId) : false;
              return (
                <div key={role} className="role-activity-row">
                  <label
                    className="role-mix-check"
                    title={
                      stem
                        ? `${included ? 'Remove' : 'Add'} ${stem.label} ${included ? 'from' : 'to'} the karaoke mix`
                        : 'No separately playable component is available'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={included}
                      disabled={!stemId}
                      onChange={(event) => {
                        if (stemId) onStemEnabledChange(stemId, event.target.checked);
                      }}
                    />
                    <span className="sr-only">
                      {stem
                        ? `Include ${stem.label} in the karaoke mix`
                        : `${ROLE_LABELS[role]} has no playable component`}
                    </span>
                  </label>
                  <span className="role-label" title={`${ROLE_LABELS[role]} — matches its ball color`}>
                    <i className="role-swatch" style={{ background: color }} />
                    {ROLE_LABELS[role]}
                  </span>
                  <svg
                    className="role-activity-strip"
                    viewBox={`0 0 ${bins} 100`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={`${ROLE_LABELS[role]} activity over time`}
                  >
                    {activity.map((value, i) =>
                      value > 0 ? (
                        <rect
                          key={i}
                          x={i + 0.08}
                          y={100 - value * 100}
                          width={0.84}
                          height={value * 100}
                          fill={color}
                        />
                      ) : null,
                    )}
                  </svg>
                  <span className="role-count" style={{ color }}>
                    {analysis.roleCounts[role]}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="role-activity-axis">
            <span>{formatTime(0)}</span>
            <span className="role-activity-caption">each row scaled to its own peak</span>
            <span>{formatTime(durationSec)}</span>
          </div>
        </div>
      )}

      {energyTimeline.length > 0 && (
        <div className="analysis-block">
          <h3 className="analysis-subtitle">Energy timeline</h3>
          <svg
            className="energy-spark"
            viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label="Loudness and bass energy over time with section cues"
          >
            {/* Section cue ranges (shaded) drawn behind the curves. */}
            {sectionCues.map((cue, i) => {
              const x = xFor(cue.startSec);
              const width = Math.max(2, xFor(cue.endSec) - x);
              return (
                <rect
                  key={`range-${i}`}
                  x={x}
                  y={0}
                  width={width}
                  height={SPARK_HEIGHT}
                  fill={CUE_COLORS[cue.type]}
                  opacity={0.14}
                />
              );
            })}

            {loudnessArea && <polygon points={loudnessArea} fill="rgba(68,119,255,0.18)" />}
            {loudnessPoints && (
              <polyline points={loudnessPoints} fill="none" stroke="#4dabf7" strokeWidth={2} />
            )}
            {bassPoints && (
              <polyline
                points={bassPoints}
                fill="none"
                stroke="#ffa94d"
                strokeWidth={1.5}
                opacity={0.85}
              />
            )}

            {/* Drop markers as bold vertical lines at the transient. */}
            {sectionCues
              .filter((cue) => cue.type === 'drop')
              .map((cue, i) => {
                const x = xFor(cue.peakSec ?? cue.startSec);
                return (
                  <line
                    key={`drop-${i}`}
                    x1={x}
                    y1={0}
                    x2={x}
                    y2={SPARK_HEIGHT}
                    stroke={CUE_COLORS.drop}
                    strokeWidth={2}
                    strokeDasharray="4 3"
                  />
                );
              })}
          </svg>
          <div className="energy-legend">
            <span className="legend-item"><i style={{ background: '#4dabf7' }} /> Loudness</span>
            <span className="legend-item"><i style={{ background: '#ffa94d' }} /> Bass</span>
            <span className="legend-time">{formatTime(0)}</span>
            <span className="legend-time-end">{formatTime(durationSec)}</span>
          </div>
        </div>
      )}

      {sectionCues.length > 0 && (
        <div className="analysis-block">
          <h3 className="analysis-subtitle">Detected sections</h3>
          <ul className="cue-list">
            {sectionCues.map((cue, i) => (
              <li key={i} className="cue-item">
                <span className="cue-badge" style={{ background: CUE_COLORS[cue.type] }}>
                  {cue.type}
                </span>
                <span className="cue-time">
                  {formatTime(cue.startSec)}
                  {cue.type === 'drop' ? '' : `–${formatTime(cue.endSec)}`}
                </span>
                <div className="cue-intensity-track">
                  <div
                    className="cue-intensity-fill"
                    style={{
                      width: `${Math.round(cue.intensity * 100)}%`,
                      background: CUE_COLORS[cue.type],
                    }}
                  />
                </div>
                <span className="cue-confidence">{Math.round(cue.confidence * 100)}%</span>
              </li>
            ))}
          </ul>
          <p className="analysis-note">
            These cues now direct the live scene: builds and rises lift and tighten the camera,
            drops add a brief impact response, breakdowns widen the view, and falls descend.
          </p>
        </div>
      )}
    </div>
  );
}
