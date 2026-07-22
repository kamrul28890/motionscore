import { useState, useCallback } from 'react';
import { FileUpload } from './components/FileUpload.js';
import { ConfigForm } from './components/ConfigForm.js';
import { ProgressDisplay } from './components/ProgressDisplay.js';
import { VideoPlayer } from './components/VideoPlayer.js';

export type AppState = 'idle' | 'uploading' | 'generating' | 'complete' | 'error';

export interface GenerateOptions {
  fps: number;
  width: number;
  height: number;
  layout: 'piano-keys' | 'lanes';
}

export interface PipelineStats {
  totalNotes: number;
  renderedFrames: number;
  durationSec: number;
  maxSyncErrorMs: number;
}

export interface ProgressEvent {
  stage?: string;
  message: string;
  percent?: number;
  status?: 'complete' | 'error';
  stats?: PipelineStats;
  videoUrl?: string;
}

export function App() {
  const [state, setState] = useState<AppState>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState<GenerateOptions>({
    fps: 60,
    width: 1920,
    height: 1080,
    layout: 'piano-keys',
  });
  const [progress, setProgress] = useState<ProgressEvent[]>([]);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleGenerate = useCallback(async () => {
    if (!file) return;

    setState('uploading');
    setProgress([]);
    setVideoUrl(null);
    setStats(null);
    setErrorMessage(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('fps', String(options.fps));
    formData.append('width', String(options.width));
    formData.append('height', String(options.height));
    formData.append('layout', options.layout);

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
            <VideoPlayer
              videoUrl={videoUrl}
              jobId={jobId!}
              stats={stats}
              onReset={handleReset}
            />
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
