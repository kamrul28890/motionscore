import { useState, useCallback } from 'react';
import { FileUpload } from './components/FileUpload.js';
import { ConfigForm } from './components/ConfigForm.js';
import { ProgressDisplay } from './components/ProgressDisplay.js';
import { AnalysisPanel } from './components/AnalysisPanel.js';
import { LiveScene } from './components/LiveScene.js';
import { DEFAULT_SCENE_SETTINGS, type Scene2DSettings } from './scene2d/index.js';
import type { ResultPayload } from './renderTypes.js';

export type AppState = 'idle' | 'uploading' | 'generating' | 'complete' | 'error';

export type HitRole =
  | 'kick'
  | 'bass'
  | 'snare'
  | 'percussion'
  | 'melodic'
  | 'vocal'
  | 'piano'
  | 'guitar';

export interface SectionCue {
  type: 'build' | 'drop' | 'breakdown' | 'rise' | 'fall';
  startSec: number;
  endSec: number;
  peakSec?: number;
  intensity: number;
  confidence: number;
}

export interface AudioEnergySample {
  timeSec: number;
  loudness: number;
  bassEnergy: number;
}

export interface AudioAnalysisSummary {
  mode: 'stems';
  tempoBpm: number;
  durationSec: number;
  hitCount: number;
  roleCounts: Record<HitRole, number>;
  /** Per-role normalized [0,1] activity bins over the song (see server contract). */
  roleActivity: Record<HitRole, number[]>;
  sectionCues: SectionCue[];
  energyTimeline: AudioEnergySample[];
}

export interface ProgressEvent {
  stage?: string;
  message: string;
  percent?: number;
  status?: 'complete' | 'error';
  analysis?: AudioAnalysisSummary;
  resultUrl?: string;
  audioUrl?: string;
}

export function App() {
  const [state, setState] = useState<AppState>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [analysis, setAnalysis] = useState<AudioAnalysisSummary | null>(null);
  const [result, setResult] = useState<ResultPayload | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [rideSettings, setRideSettings] = useState<Scene2DSettings>(DEFAULT_SCENE_SETTINGS);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!file) return;

    setState('uploading');
    setProgress([]);
    setAnalysis(null);
    setResult(null);
    setAudioUrl(null);
    setErrorMessage(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }));
        throw new Error(err.error ?? 'Upload failed');
      }

      const { jobId: id } = await res.json();
      setState('generating');

      // Subscribe to SSE progress
      const eventSource = new EventSource(`/api/progress/${id}`);

      eventSource.onmessage = (event) => {
        const data: ProgressEvent = JSON.parse(event.data);
        setProgress((prev) => [...prev, data]);

        if (data.status === 'complete') {
          setState('complete');
          setAnalysis(data.analysis ?? null);
          setAudioUrl(data.audioUrl ?? null);
          // Fetch the full analysis payload for the live scene (kept off the SSE
          // frame because the analysis JSON can be large).
          const resultUrl = data.resultUrl ?? `/api/result/${id}`;
          fetch(resultUrl)
            .then((r) => (r.ok ? r.json() : null))
            .then((payload: ResultPayload | null) => setResult(payload))
            .catch(() => setResult(null));
          eventSource.close();
        } else if (data.status === 'error') {
          setState('error');
          setErrorMessage(data.message);
          eventSource.close();
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        // Only set error if we haven't already completed
        setState((current) => {
          if (current === 'generating') {
            setErrorMessage('Connection to server lost');
            return 'error';
          }
          return current;
        });
      };
    } catch (err: any) {
      setState('error');
      setErrorMessage(err.message ?? 'Something went wrong');
    }
  }, [file]);

  const handleReset = useCallback(() => {
    setState('idle');
    setFile(null);
    setProgress([]);
    setAnalysis(null);
    setResult(null);
    setAudioUrl(null);
    setErrorMessage(null);
  }, []);

  const busy = state === 'uploading' || state === 'generating';

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <path
              className="brand-line"
              d="M2 22 Q 9 22 12 12 T 21 12 Q 26 12 30 19"
              fill="none"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
            <circle className="brand-ball" cx="12" cy="9" r="3.2" />
          </svg>
          <div className="brand-text">
            <h1>MotionScore</h1>
            <p className="subtitle">Music-to-physics live visualizer</p>
          </div>
        </div>
      </header>

      <main className="app-main">
        <aside className="panel-left">
          <FileUpload file={file} onFileSelect={setFile} disabled={busy} />
          <ConfigForm onGenerate={handleGenerate} disabled={busy} canGenerate={file !== null} />
        </aside>

        <section className="panel-right">
          {busy && <ProgressDisplay events={progress} />}

          {state === 'complete' && audioUrl && (
            <>
              <LiveScene
                result={result}
                audioUrl={audioUrl}
                settings={rideSettings}
                onSettingsChange={setRideSettings}
                onReset={handleReset}
              />
              {analysis && <AnalysisPanel analysis={analysis} />}
            </>
          )}

          {state === 'error' && (
            <div className="card state-card state-error">
              <span className="state-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </span>
              <div className="state-body">
                <h3>Generation failed</h3>
                <p className="state-message">{errorMessage}</p>
                <button className="btn btn-primary" onClick={handleReset} type="button">
                  Try again
                </button>
              </div>
            </div>
          )}

          {state === 'idle' && (
            <div className="card state-card state-idle">
              <span className="state-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="12" x2="3" y2="12" />
                  <line x1="6" y1="9" x2="6" y2="15" />
                  <line x1="9.5" y1="5" x2="9.5" y2="19" />
                  <line x1="13" y1="8" x2="13" y2="16" />
                  <line x1="16.5" y1="4" x2="16.5" y2="20" />
                  <line x1="20" y1="10" x2="20" y2="14" />
                </svg>
              </span>
              <div className="state-body">
                <h3>No audio loaded</h3>
                <p className="state-message">
                  Add an audio file in the panel on the left to analyze it and build a live
                  physics visualization — one bouncing ball per detected instrument.
                </p>
                <ol className="state-steps">
                  <li>Choose an audio file (.mp3, .wav, .flac, .ogg)</li>
                  <li>Run the analysis to separate instruments into stems</li>
                  <li>Watch each sound ride its own line, then fine-tune the scene</li>
                </ol>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
