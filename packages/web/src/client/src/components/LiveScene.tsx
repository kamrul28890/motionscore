import { useEffect, useMemo, useRef } from 'react';
import type { ResultPayload } from '../renderTypes.js';
import { RideControls } from './RideControls.js';
import { StemMixer } from './StemMixer.js';
import {
  type Ctx2D,
  type Scene2DSettings,
  buildScene2D,
  createCamera,
  renderScene2D,
} from '../scene2d/index.js';

interface LiveSceneProps {
  /** Full analysis payload from /api/result (may arrive slightly after mount). */
  result: ResultPayload | null;
  /** URL of the original audio; this <audio> element is the master clock. */
  audioUrl: string;
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
        <div className="live-title">
          <h2>Live visualization</h2>
          <span className="live-badge">2D physics &middot; solved from audio</span>
        </div>
        <button className="btn btn-ghost live-reset" onClick={onReset} type="button">
          <span className="btn-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </span>
          Analyze another
        </button>
      </div>

      <div className="live-stage">
        <div className="live-canvas-wrap" ref={wrapRef}>
          <canvas ref={canvasRef} className="live-canvas" />
          {result === null && (
            <div className="live-overlay">
              <span className="live-spinner" aria-hidden="true" />
              <span>Loading choreography&hellip;</span>
            </div>
          )}
          {showEmpty && (
            <div className="live-overlay live-overlay-empty">
              <p>No instrument tracks to show.</p>
              <p className="live-overlay-sub">
                Turn a ball back on with its show/hide toggle in Scene controls below, or choose
                &ldquo;Reset to one ball per sound&rdquo; to restore the default grouping.
              </p>
            </div>
          )}
        </div>

        {analysis && (
          <div className="live-meta">
            <span className="live-meta-item">
              <b>{analysis.hits.length}</b> hits
            </span>
            <span className="live-meta-sep" aria-hidden="true" />
            <span className="live-meta-item">
              <b>{analysis.durationSec.toFixed(1)}s</b> duration
            </span>
          </div>
        )}
      </div>

      <audio ref={audioRef} src={audioUrl} controls className="live-audio" />

      {result?.stems && result.stems.length > 0 && (
        <StemMixer masterRef={audioRef} stems={result.stems} />
      )}

      <RideControls
        settings={settings}
        onChange={onSettingsChange}
        suggestions={model.mergeSuggestions}
      />
    </div>
  );
}
