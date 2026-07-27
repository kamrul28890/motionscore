import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  RuntimeMode,
  RuntimeProgress,
  RuntimeStatus,
} from '../runtimeTypes.js';

interface RuntimeSetupProps {
  status: RuntimeStatus;
  onReady: (status: RuntimeStatus) => void;
  onStatusChange: (status: RuntimeStatus) => void;
}

async function readError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? `Setup request failed (${response.status})`;
}

export function RuntimeSetup({
  status,
  onReady,
  onStatusChange,
}: RuntimeSetupProps) {
  const [mode, setMode] = useState<RuntimeMode>(
    status.nvidiaAvailable ? 'cuda' : 'cpu',
  );
  const [events, setEvents] = useState<RuntimeProgress[]>([]);
  const [installing, setInstalling] = useState(status.state === 'installing');
  const [requestError, setRequestError] = useState<string | null>(status.error ?? null);
  const sourceRef = useRef<EventSource | null>(null);

  const latest = events.at(-1);
  const percent = latest?.percent ?? (installing ? 1 : 0);
  const recentEvents = useMemo(() => events.slice(-8), [events]);

  const refreshStatus = async (): Promise<void> => {
    const response = await fetch('/api/runtime/status');
    if (!response.ok) throw new Error(await readError(response));
    const next = (await response.json()) as RuntimeStatus;
    onStatusChange(next);
    if (next.ready) onReady(next);
  };

  const watchProgress = (): void => {
    sourceRef.current?.close();
    const source = new EventSource('/api/runtime/progress');
    sourceRef.current = source;
    source.onmessage = (event) => {
      const progress = JSON.parse(event.data) as RuntimeProgress;
      setEvents((current) => [...current, progress]);
      if (progress.status === 'complete') {
        source.close();
        setInstalling(false);
        void refreshStatus().catch((cause) => {
          setRequestError(cause instanceof Error ? cause.message : String(cause));
        });
      } else if (progress.status === 'error') {
        source.close();
        setInstalling(false);
        setRequestError(progress.message);
      }
    };
    source.onerror = () => {
      source.close();
      if (installing) {
        setRequestError('The setup progress connection closed unexpectedly. You can retry safely.');
        setInstalling(false);
      }
    };
  };

  useEffect(() => {
    if (status.state === 'installing') watchProgress();
    return () => sourceRef.current?.close();
    // Subscribe once for a setup that was already running when this view mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startInstall = async (): Promise<void> => {
    setEvents([]);
    setRequestError(null);
    setInstalling(true);
    const response = await fetch('/api/runtime/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!response.ok) {
      setInstalling(false);
      setRequestError(await readError(response));
      return;
    }
    watchProgress();
  };

  return (
    <main className="runtime-shell">
      <section className="runtime-setup card" aria-labelledby="runtime-title">
        <div className="runtime-intro">
          <span className="runtime-kicker">First-run setup</span>
          <h2 id="runtime-title">Prepare music analysis</h2>
          <p>
            MotionScore will install a private Python environment, PyTorch, Demucs,
            librosa, FFmpeg, and the separation model. Nothing is added to your
            system PATH, and no administrator access is required.
          </p>
        </div>

        <div className="runtime-choice" role="radiogroup" aria-label="Analysis runtime">
          <label className={`runtime-option${mode === 'cpu' ? ' runtime-option-active' : ''}`}>
            <input
              type="radio"
              name="runtime-mode"
              value="cpu"
              checked={mode === 'cpu'}
              disabled={installing}
              onChange={() => setMode('cpu')}
            />
            <span className="runtime-option-copy">
              <b>CPU — compatible</b>
              <small>Works on nearly every Windows computer. Analysis is slower.</small>
            </span>
            {!status.nvidiaAvailable && <em>Recommended</em>}
          </label>

          <label
            className={`runtime-option${mode === 'cuda' ? ' runtime-option-active' : ''}${
              !status.nvidiaAvailable ? ' runtime-option-disabled' : ''
            }`}
          >
            <input
              type="radio"
              name="runtime-mode"
              value="cuda"
              checked={mode === 'cuda'}
              disabled={installing || !status.nvidiaAvailable}
              onChange={() => setMode('cuda')}
            />
            <span className="runtime-option-copy">
              <b>NVIDIA GPU — faster</b>
              <small>
                Uses the CUDA runtime when a compatible NVIDIA driver is detected.
              </small>
            </span>
            {status.nvidiaAvailable && <em>Recommended</em>}
          </label>
        </div>

        <div className="runtime-facts">
          <span>Internet required</span>
          <span>Several GB of free disk space</span>
          <span>One-time setup</span>
          <span>Private per-user runtime</span>
        </div>

        {installing ? (
          <div className="runtime-progress" aria-live="polite">
            <div className="runtime-progress-head">
              <div>
                <span>{latest?.stage ?? 'Starting setup'}</span>
                <small>{latest?.message ?? 'Preparing the installer'}</small>
              </div>
              <b>{Math.round(percent)}%</b>
            </div>
            <div
              className="runtime-progress-track"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
            >
              <div style={{ width: `${Math.max(1, percent)}%` }} />
            </div>
            <ol className="runtime-progress-log">
              {recentEvents.map((event, index) => (
                <li key={`${event.stage}-${index}`}>
                  <span>{event.stage}</span>
                  <small>{event.message}</small>
                </li>
              ))}
            </ol>
            <p className="runtime-wait-note">
              Keep MotionScore open. Large PyTorch downloads may make one percentage
              remain visible for several minutes.
            </p>
          </div>
        ) : (
          <div className="runtime-actions">
            <button className="btn btn-primary" type="button" onClick={() => void startInstall()}>
              {status.pythonPath ? 'Repair analysis runtime' : `Install ${mode === 'cuda' ? 'GPU' : 'CPU'} runtime`}
            </button>
            <p>
              Installation location: <code>{status.runtimeRoot}</code>
            </p>
          </div>
        )}

        {requestError && (
          <div className="runtime-error" role="alert">
            <b>Setup needs attention</b>
            <p>{requestError}</p>
          </div>
        )}
      </section>
    </main>
  );
}
