import { useEffect, useRef, useState } from 'react';
import type { ProgressEvent } from '../App.js';

interface ProgressDisplayProps {
  events: ProgressEvent[];
}

export function ProgressDisplay({ events }: ProgressDisplayProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef(Date.now());

  // Elapsed time counter
  useEffect(() => {
    startTimeRef.current = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events]);

  // Use the most recent event that actually carries a value, so interleaved
  // messages without a percent/stage (e.g. "validated ...") don't reset the bar
  // to 0 or blank the current stage label.
  let percent = 0;
  let currentStage = 'Initializing';
  for (const event of events) {
    if (event.percent !== undefined) percent = Math.max(percent, event.percent);
    if (event.stage !== undefined) currentStage = event.stage;
  }

  const formatTime = (secs: number): string => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  };

  return (
    <div className="card progress-card">
      <div className="card-head">
        <h2>Analyzing</h2>
        <span className="progress-time">{formatTime(elapsed)}</span>
      </div>

      <div className="progress-status">
        <span className="progress-dot" aria-hidden="true" />
        <span className="progress-stage">{currentStage}</span>
        <span className="progress-percent-inline">{percent}%</span>
      </div>

      <div className="progress-bar-container">
        <div
          className="progress-bar"
          style={{ width: `${Math.min(100, percent)}%` }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>

      <div className="progress-log" ref={logRef}>
        {events.map((event, i) => (
          <div key={i} className={`log-entry ${event.status === 'error' ? 'log-error' : ''}`}>
            <span className="log-message">{event.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
