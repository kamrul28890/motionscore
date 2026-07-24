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

  return (
    <div className="app">
      <header className="app-header">
        <h1>MotionScore</h1>
        <p className="subtitle">Music-to-physics live visualizer</p>
      </header>

      <main className="app-main">
        <div className="panel-left">
          <FileUpload
            file={file}
            onFileSelect={setFile}
            disabled={state === 'uploading' || state === 'generating'}
          />
          <ConfigForm
            onGenerate={handleGenerate}
            disabled={state === 'uploading' || state === 'generating'}
            canGenerate={file !== null}
          />
        </div>

        <div className="panel-right">
          {(state === 'uploading' || state === 'generating') && (
            <ProgressDisplay events={progress} />
          )}

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
            <div className="card error-card">
              <h3>Generation Failed</h3>
              <p className="error-message">{errorMessage}</p>
              <button className="btn btn-primary" onClick={handleReset}>
                Try Again
              </button>
            </div>
          )}

          {state === 'idle' && (
            <div className="card placeholder-card">
              <div className="placeholder-icon">🎵</div>
              <p>Upload an audio file to visualize it.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
