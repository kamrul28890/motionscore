import type { PipelineStats } from '../App.js';

interface VideoPlayerProps {
  videoUrl: string;
  jobId: string;
  stats: PipelineStats | null;
  onReset: () => void;
}

export function VideoPlayer({ videoUrl, jobId, stats, onReset }: VideoPlayerProps) {
  return (
    <div className="card video-card">
      <h2>Generated Video</h2>

      <div className="video-wrapper">
        <video
          src={videoUrl}
          controls
          autoPlay
          className="video-player"
          aria-label="Generated MotionScore video"
        />
      </div>

      {stats && (
        <div className="stats-grid">
          <div className="stat">
            <span className="stat-value">{stats.totalNotes}</span>
            <span className="stat-label">Notes</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats.renderedFrames}</span>
            <span className="stat-label">Frames</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats.durationSec.toFixed(1)}s</span>
            <span className="stat-label">Duration</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats.maxSyncErrorMs.toFixed(2)}ms</span>
            <span className="stat-label">Max Sync Error</span>
          </div>
        </div>
      )}

      <div className="video-actions">
        <a
          href={`/api/video/${jobId}/download`}
          className="btn btn-primary"
          download
        >
          Download MP4
        </a>
        <button className="btn btn-secondary" onClick={onReset} type="button">
          New Video
        </button>
      </div>
    </div>
  );
}
