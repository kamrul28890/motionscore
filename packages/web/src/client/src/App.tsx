import { useState, useCallback } from 'react';
import { FileUpload } from './components/FileUpload.js';
import { ConfigForm } from './components/ConfigForm.js';
import { ProgressDisplay } from './components/ProgressDisplay.js';
import { VideoPlayer } from './components/VideoPlayer.js';
import { AnalysisPanel } from './components/AnalysisPanel.js';

export type AppState = 'idle' | 'uploading' | 'generating' | 'complete' | 'error';

export type ExtractionMode = 'auto' | 'beats' | 'onsets' | 'stems' | 'notes';
export type BallMode = 'single' | 'per-role';

export interface GenerateOptions {
  mode: ExtractionMode;
  balls: BallMode;
  fps: number;
  width: number;
  height: number;
  layout: 'piano-keys' | 'lanes';
  codec: string;
  gpuDevice: number;
  preset: string;
  parallelFrames: number;
}

export interface PipelineStats {
  totalNotes: number;
  renderedFrames: number;
  durationSec: number;
  maxSyncErrorMs: number;
}

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
  mode: 'smart' | 'beats' | 'onsets' | 'stems';
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
  stats?: PipelineStats;
  analysis?: AudioAnalysisSummary;
  videoUrl?: string;
}

export function App() {
  const [state, setState] = useState<AppState>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState<GenerateOptions>({
    mode: 'auto',
    balls: 'single',
    fps: 60,
    width: 1920,
    height: 1080,
    layout: 'piano-keys',
    codec: 'libx264',
    gpuDevice: 0,
    preset: '',
    parallelFrames: 4,
  });
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [analysis, setAnalysis] = useState<AudioAnalysisSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!file) return;

    setState('uploading');
    setProgress([]);
    setVideoUrl(null);
    setStats(null);
    setAnalysis(null);
    setErrorMessage(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('mode', options.mode);
    formData.append('balls', options.balls);
    formData.append('fps', String(options.fps));
    formData.append('width', String(options.width));
    formData.append('height', String(options.height));
    formData.append('layout', options.layout);
    formData.append('codec', options.codec);
    formData.append('gpuDevice', String(options.gpuDevice));
    if (options.preset) formData.append('preset', options.preset);
    formData.append('parallelFrames', String(options.parallelFrames));

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
      setJobId(id);
      setState('generating');

      // Subscribe to SSE progress
      const eventSource = new EventSource(`/api/progress/${id}`);

      eventSource.onmessage = (event) => {
        const data: ProgressEvent = JSON.parse(event.data);
        setProgress((prev) => [...prev, data]);

        if (data.status === 'complete') {
          setState('complete');
          setVideoUrl(data.videoUrl ?? `/api/video/${id}`);
          setStats(data.stats ?? null);
          setAnalysis(data.analysis ?? null);
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
  }, [file, options]);

  const handleReset = useCallback(() => {
    setState('idle');
    setFile(null);
    setProgress([]);
    setVideoUrl(null);
    setJobId(null);
    setStats(null);
    setAnalysis(null);
    setErrorMessage(null);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>MotionScore</h1>
        <p className="subtitle">Music-to-physics video generator</p>
      </header>

      <main className="app-main">
        <div className="panel-left">
          <FileUpload
            file={file}
            onFileSelect={setFile}
            disabled={state === 'uploading' || state === 'generating'}
          />
          <ConfigForm
            options={options}
            onChange={setOptions}
            onGenerate={handleGenerate}
            disabled={state === 'uploading' || state === 'generating'}
            canGenerate={file !== null}
          />
        </div>

        <div className="panel-right">
          {(state === 'uploading' || state === 'generating') && (
            <ProgressDisplay events={progress} />
          )}

          {state === 'complete' && videoUrl && (
            <>
              <VideoPlayer
                videoUrl={videoUrl}
                jobId={jobId!}
                stats={stats}
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
              <p>Upload a MIDI or audio file and configure your settings to generate a video.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
