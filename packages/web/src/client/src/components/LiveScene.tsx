import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { AudioAnalysisSummary } from '../App.js';
import type { HitRole, ResultPayload } from '../renderTypes.js';
import { AnalysisPanel } from './AnalysisPanel.js';
import { RideControls } from './RideControls.js';
import { SceneLegend } from './SceneLegend.js';
import { SongMinimap } from './SongMinimap.js';
import { StemMixer, type PlaybackSource } from './StemMixer.js';
import {
  type Ctx2D,
  type Scene2DSettings,
  buildScene2D,
  createCamera,
  renderScene2D,
  sampleActor,
} from '../scene2d/index.js';
import {
  describeScene,
  rolesForStem,
  sectionAt,
  stemForRole,
} from '../visualization-state.js';

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
  const [activeWorkspace, setActiveWorkspace] = useState<'live' | 'source' | 'scene'>('live');
  const [visualMode, setVisualMode] = useState<'performance' | 'insight'>('insight');
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedRole, setSelectedRole] = useState<HitRole | null>(null);
  const [hoveredRole, setHoveredRole] = useState<HitRole | null>(null);
  const [hoveredStem, setHoveredStem] = useState<string | null>(null);
  const [soloStem, setSoloStem] = useState<string | null>(null);
  const [playbackSource, setPlaybackSource] = useState<PlaybackSource>('components');
  const [enabledStemIds, setEnabledStemIds] = useState<string[]>([]);
  const visualModeRef = useRef(visualMode);
  const reducedMotionRef = useRef(reducedMotion);
  const focusedRoleRef = useRef<HitRole | null>(null);

  const analysis = result?.analysis ?? null;
  const model = useMemo(() => buildScene2D(analysis, settings), [analysis, settings]);
  const modelRef = useRef(model);
  const focusedRole =
    hoveredRole ?? (hoveredStem ? (rolesForStem(hoveredStem)[0] ?? null) : selectedRole);
  const focusedRoles = hoveredStem ? rolesForStem(hoveredStem) : focusedRole ? [focusedRole] : [];
  const sceneRoles = model.actors
    .flatMap((actor) => actor.sourceRoles)
    .filter((role, index, roles) => roles.indexOf(role) === index);
  const activeCue = analysis ? sectionAt(analysis.sectionCues, currentTime) : null;
  const sceneDescription = analysis
    ? describeScene(analysis, sceneRoles, currentTime)
    : 'The analyzed scene is loading.';

  useEffect(() => {
    visualModeRef.current = visualMode;
  }, [visualMode]);

  useEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  useEffect(() => {
    focusedRoleRef.current = focusedRole;
  }, [focusedRole]);

  const stemKey = (result?.stems ?? []).map((stem) => stem.id).join('|');
  useEffect(() => {
    setEnabledStemIds((result?.stems ?? []).map((stem) => stem.id));
    setSoloStem(null);
    setPlaybackSource('components');
  }, [result?.audioUrl, stemKey]);

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
    let lastUiTime = -1;
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
      if (Math.abs(t - lastUiTime) >= 0.08 || t === 0) {
        lastUiTime = t;
        setCurrentTime(t);
      }
      renderScene2D(ctx, modelRef.current, {
        timeSec: t,
        dt,
        width: canvas.width,
        height: canvas.height,
        camera: cameraRef.current,
        mode: visualModeRef.current,
        focusedRole: focusedRoleRef.current,
        reducedMotion: reducedMotionRef.current,
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
  const selectRole = (role: HitRole | null): void => {
    setSelectedRole(role);
    setHoveredRole(null);
    if (!role) {
      setSoloStem(null);
      return;
    }
    const stem = stemForRole(role, result?.stems ?? []);
    if (stem) {
      setSoloStem(stem);
      setPlaybackSource('components');
    }
  };
  const setStemEnabled = (stemId: string, enabled: boolean): void => {
    setEnabledStemIds((current) =>
      enabled
        ? current.includes(stemId)
          ? current
          : [...current, stemId]
        : current.filter((id) => id !== stemId),
    );
    setSoloStem(null);
    setPlaybackSource('components');
  };
  const seek = (timeSec: number): void => {
    const audio = audioRef.current;
    if (!audio || !analysis) return;
    audio.currentTime = Math.min(analysis.durationSec, Math.max(0, timeSec));
    setCurrentTime(audio.currentTime);
    cameraRef.current.inited = false;
  };
  const clickCanvas = (event: MouseEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas || model.actors.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width)) * canvas.width;
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height)) * canvas.height;
    const camera = cameraRef.current;
    let closest: { role: HitRole; distance: number } | null = null;
    for (const actor of model.actors) {
      if (actor.sourceRoles.length === 0) continue;
      const point = sampleActor(actor, currentTime);
      const screenX = canvas.width / 2 + (point.x - camera.x) * camera.scale;
      const screenY = canvas.height / 2 + (point.y - camera.y) * camera.scale;
      const distance = Math.hypot(screenX - x, screenY - y);
      if (!closest || distance < closest.distance) {
        closest = { role: actor.sourceRoles[0]!, distance };
      }
    }
    selectRole(closest && closest.distance <= Math.max(24, camera.scale * 0.9) ? closest.role : null);
  };

  return (
    <div className="card live-card">
      <div className="live-header">
        <div className="top-view-tabs" role="tablist" aria-label="MotionScore views">
          <button
            id="workspace-live-tab"
            className={`top-view-tab${activeWorkspace === 'live' ? ' top-view-tab-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={activeWorkspace === 'live'}
            aria-controls="workspace-live-panel"
            onClick={() => setActiveWorkspace('live')}
          >
            <span>Live visualization</span>
            <small>Watch the choreography</small>
          </button>
          <button
            id="workspace-source-tab"
            className={`top-view-tab${activeWorkspace === 'source' ? ' top-view-tab-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={activeWorkspace === 'source'}
            aria-controls="workspace-source-panel"
            onClick={() => setActiveWorkspace('source')}
          >
            <span>Source Lab</span>
            <small>Listen &amp; inspect</small>
          </button>
          <button
            id="workspace-scene-tab"
            className={`top-view-tab${activeWorkspace === 'scene' ? ' top-view-tab-active' : ''}`}
            type="button"
            role="tab"
            aria-selected={activeWorkspace === 'scene'}
            aria-controls="workspace-scene-panel"
            onClick={() => setActiveWorkspace('scene')}
          >
            <span>Scene Controls</span>
            <small>Shape the motion</small>
          </button>
        </div>
        {activeWorkspace === 'live' && (
          <div className="visual-display-controls" aria-label="Visualization display">
          <div className="visual-mode-switch" role="group" aria-label="Scene detail mode">
            <button
              type="button"
              aria-pressed={visualMode === 'performance'}
              className={visualMode === 'performance' ? 'visual-mode-active' : ''}
              onClick={() => setVisualMode('performance')}
            >
              Performance
            </button>
            <button
              type="button"
              aria-pressed={visualMode === 'insight'}
              className={visualMode === 'insight' ? 'visual-mode-active' : ''}
              onClick={() => setVisualMode('insight')}
            >
              Insight
            </button>
          </div>
          <label className="motion-toggle">
            <input
              type="checkbox"
              checked={reducedMotion}
              onChange={(event) => setReducedMotion(event.target.checked)}
            />
            Reduced motion
          </label>
          </div>
        )}
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

      <div className="timeline-transport">
        <div className="timeline-transport-copy">
          <span>Master timeline</span>
          <small>Play, pause, or seek here—the scene and every selected component follow.</small>
        </div>
        <audio ref={audioRef} src={audioUrl} controls className="live-audio" />
      </div>

      <div
        id="workspace-live-panel"
        className="primary-view-panel live-view-panel"
        role="tabpanel"
        aria-labelledby="workspace-live-tab"
        hidden={activeWorkspace !== 'live'}
      >
      <div className="live-stage">
        <div className="live-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className="live-canvas"
            role="img"
            aria-label={sceneDescription}
            onClick={clickCanvas}
          >
            {sceneDescription}
          </canvas>
          {analysis && visualMode === 'insight' && (
            <SceneLegend
              actors={model.actors}
              analysis={analysis}
              timeSec={currentTime}
              selectedRole={selectedRole}
              onSelectRole={selectRole}
              onHoverRole={setHoveredRole}
            />
          )}
          {activeCue && (
            <div className={`section-indicator section-indicator-${activeCue.type}`}>
              <b>{activeCue.type}</b>
              <span>{Math.round(activeCue.intensity * 100)}% intensity</span>
            </div>
          )}
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
            <span className="live-meta-sep" aria-hidden="true" />
            <span className="live-meta-item">
              Vertical <b>pitch</b> · horizontal <b>time</b> · rail glow <b>activity</b>
            </span>
          </div>
        )}
      </div>

      {analysis && (
        <>
          <SongMinimap
            analysis={analysis}
            roles={sceneRoles}
            timeSec={currentTime}
            onSeek={seek}
          />
          <p className="scene-description" aria-live="polite">
            <b>Now:</b> {sceneDescription}
          </p>
        </>
      )}
      </div>

      <section className="workspace">
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
            <StemMixer
              masterRef={audioRef}
              stems={result.stems}
              analysis={analysis}
              soloStem={soloStem}
              onSoloStemChange={setSoloStem}
              playbackSource={playbackSource}
              onPlaybackSourceChange={setPlaybackSource}
              enabledStemIds={enabledStemIds}
              onStemEnabledChange={setStemEnabled}
              focusedRoles={focusedRoles}
              onStemFocus={setHoveredStem}
            />
          ) : (
            <div className="workspace-empty">
              Playable components will appear here when separation finishes.
            </div>
          )}
          {analysisSummary && (
            <AnalysisPanel
              analysis={analysisSummary}
              stems={result?.stems ?? []}
              enabledStemIds={enabledStemIds}
              onStemEnabledChange={setStemEnabled}
            />
          )}
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
