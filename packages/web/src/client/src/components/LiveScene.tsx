import { useEffect, useMemo, useRef } from 'react';
import type { PipelineStats } from '../App.js';
import type { ResultPayload } from '../renderTypes.js';
import { RideControls } from './RideControls.js';
import {
  type Ctx2D,
  type Scene2DSettings,
  buildScene2D,
  createCamera,
  renderScene2D,
} from '../scene2d/index.js';

interface LiveSceneProps {
  /** Full choreography + analysis payload from /api/result (may arrive slightly after mount). */
  result: ResultPayload | null;
  /** URL of the original audio; this <audio> element is the master clock. */
  audioUrl: string;
  /** Baked MP4 URL (download fallback). */
  videoUrl: string | null;
  jobId: string;
  stats: PipelineStats | null;
  settings: Scene2DSettings;
  onSettingsChange: (next: Scene2DSettings) => void;
  onReset: () => void;
}

/**
 * Real-time 2D visualizer: a plain <canvas> driven by a requestAnimationFrame
 * loop that reads `audio.currentTime` (the master clock) each frame, so visuals
 * stay locked to playback and to pause/seek. All drawing lives in the
 * framework-agnostic `scene2d` module (shareable with the MP4 exporter).
 */
export function LiveScene({
  result,
  audioUrl,
  videoUrl,
  jobId,
  stats,
  settings,
  onSettingsChange,
  onReset,
}: LiveSceneProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(createCamera());

  const analysis = result?.analysis ?? null;
  const model = useMemo(() => buildScene2D(analysis, settings), [analysis, settings]);
  const modelRef = useRef(model);

  // Swap in a rebuilt model and reframe the camera when data/settings change.
  useEffect(() => {
    modelRef.current = model;
    cameraRef.current.inited = false;
  }, [model]);

  // The render loop. Set up once; reads the latest model/camera from refs.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d') as unknown as Ctx2D | null;
    if (!ctx) return;

    const resize = (): void => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    let lastWall = -1;
    let lastAudio = -1;
    const loop = (): void => {
      const audio = audioRef.current;
      const t = audio?.currentTime ?? 0;
      const now = performance.now() / 1000;
      let dt = lastWall < 0 ? 0 : now - lastWall;
      lastWall = now;
      if (dt > 0.1) dt = 0.1; // clamp tab-switch gaps
      if (lastAudio >= 0 && Math.abs(t - lastAudio) > 0.35) {
        cameraRef.current.inited = false; // seek/loop -> snap, don't slew
      }
      lastAudio = t;
      renderScene2D(ctx, modelRef.current, {
        timeSec: t,
        dt,
        width: canvas.width,
        height: canvas.height,
        camera: cameraRef.current,
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const showEmpty = result !== null && model.actors.length === 0;

  return (
    <div className="card live-card">
      <div className="live-header">
        <h2>Neural Physics Race</h2>
        <span className="live-badge">2D · backward-solved</span>
      </div>

      <div className="live-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="live-canvas" />
        {result === null && <div className="live-overlay">Loading choreography…</div>}
        {showEmpty && (
          <div className="live-overlay">
            No instrument tracks to show. Enable instruments below, or if you customized
            the ball groupings, open “Edit groupings” and choose “Reset to default”.
          </div>
        )}
      </div>

      <audio ref={audioRef} src={audioUrl} controls className="live-audio" />

      <RideControls settings={settings} onChange={onSettingsChange} />

      {stats && (
        <div className="stats-grid">
          <div className="stat">
            <span className="stat-value">{stats.totalNotes}</span>
            <span className="stat-label">Notes</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats.durationSec.toFixed(1)}s</span>
            <span className="stat-label">Duration</span>
          </div>
          <div className="stat">
            <span className="stat-value">{stats.maxSyncErrorMs.toFixed(2)}ms</span>
            <span className="stat-label">Max Sync</span>
          </div>
        </div>
      )}

      <div className="video-actions">
        {videoUrl && (
          <a href={`/api/video/${jobId}/download`} className="btn btn-primary" download>
            Download MP4
          </a>
        )}
        <button className="btn btn-secondary" onClick={onReset} type="button">
          New Video
        </button>
      </div>
    </div>
  );
}
