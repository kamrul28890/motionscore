import { useEffect, useMemo, useRef, useState } from 'react';
import type { AudioAnalysisSummary } from '../App.js';
import type { ResultPayload } from '../renderTypes.js';
import { AnalysisPanel } from './AnalysisPanel.js';
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
  /** Compact analysis used by the Source Lab charts and summaries. */
  analysisSummary: AudioAnalysisSummary | null;
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
  analysisSummary,
  settings,
  onSettingsChange,
  onReset,
}: LiveSceneProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(createCamera());
  const [activeWorkspace, setActiveWorkspace] = useState<'source' | 'scene'>('source');

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

      <div className="timeline-transport">
        <div className="timeline-transport-copy">
          <span>Master timeline</span>
          <small>Play, pause, or seek here—the scene and every component follow.</small>
        </div>
        <audio ref={audioRef} src={audioUrl} controls className="live-audio" />
      </div>

      <section className="workspace">
        <div className="workspace-tabs" role="tablist" aria-label="Visualization workspace">
          <button
            id="workspace-source-tab"
            className={`workspace-tab${activeWorkspace === 'source' ? ' workspace-tab-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={activeWorkspace === 'source'}
            aria-controls="workspace-source-panel"
            onClick={() => setActiveWorkspace('source')}
          >
            <span className="workspace-tab-kicker">Listen &amp; inspect</span>
            <span className="workspace-tab-title">Source Lab</span>
            <span className="workspace-tab-meta">
              {result?.stems?.length ?? 0} playable components
            </span>
          </button>
          <button
            id="workspace-scene-tab"
            className={`workspace-tab${activeWorkspace === 'scene' ? ' workspace-tab-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={activeWorkspace === 'scene'}
            aria-controls="workspace-scene-panel"
            onClick={() => setActiveWorkspace('scene')}
          >
            <span className="workspace-tab-kicker">Shape the motion</span>
            <span className="workspace-tab-title">Scene Controls</span>
            <span className="workspace-tab-meta">
              {model.actors.length} {model.actors.length === 1 ? 'active ball' : 'active balls'}
            </span>
          </button>
        </div>

        <div
          id="workspace-source-panel"
          className="workspace-panel"
          role="tabpanel"
          aria-labelledby="workspace-source-tab"
          hidden={activeWorkspace !== 'source'}
        >
          <div className="workspace-panel-intro">
            <div>
              <span className="workspace-panel-number">01</span>
              <h3>Hear what the model found</h3>
            </div>
            <p>
              Compare the original mix with its separated components, then inspect where
              instruments, energy, and musical sections appear over time.
            </p>
          </div>

          {result?.stems && result.stems.length > 0 ? (
            <StemMixer masterRef={audioRef} stems={result.stems} analysis={analysis} />
          ) : (
            <div className="workspace-empty">
              Playable components will appear here when separation finishes.
            </div>
          )}
          {analysisSummary && <AnalysisPanel analysis={analysisSummary} />}
        </div>

        <div
          id="workspace-scene-panel"
          className="workspace-panel"
          role="tabpanel"
          aria-labelledby="workspace-scene-tab"
          hidden={activeWorkspace !== 'scene'}
        >
          <div className="workspace-panel-intro">
            <div>
              <span className="workspace-panel-number">02</span>
              <h3>Direct the choreography</h3>
            </div>
            <p>
              Group sounds into balls, change their identity, and adjust each path while the
              master timeline keeps the scene synchronized.
            </p>
          </div>
          <RideControls
            settings={settings}
            onChange={onSettingsChange}
            suggestions={model.mergeSuggestions}
          />
        </div>
      </section>
    </div>
  );
}
