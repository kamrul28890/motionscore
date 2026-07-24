import { useEffect, useRef, useState, type RefObject } from 'react';
import type { StemTrack } from '../renderTypes.js';

interface StemMixerProps {
  /** The mix <audio> element that owns transport + the visualization clock. */
  masterRef: RefObject<HTMLAudioElement | null>;
  stems: StemTrack[];
}

/**
 * In-browser stem mixer: play the separated instrument stems in lock-step with
 * the mix element (which stays the transport + visual clock) and let the user
 * mute or solo each one. The mix itself is muted while stems play, so what you
 * hear is the sum of the un-muted stems — muting a stem removes exactly that
 * instrument. The stems are kept aligned to the mix on play/pause/seek and by a
 * periodic drift check. Only whole Demucs stems are separable; kick/snare/perc
 * are analysis-only band splits of the one drums stem, so they are not listed.
 */
export function StemMixer({ masterRef, stems }: StemMixerProps) {
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [solo, setSolo] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const stemEls = (): HTMLAudioElement[] =>
    rootRef.current
      ? Array.from(rootRef.current.querySelectorAll<HTMLAudioElement>('audio[data-stem]'))
      : [];

  // Mirror the mix transport onto every stem, and keep them drift-corrected.
  useEffect(() => {
    const master = masterRef.current;
    if (!master) return;
    // Stems provide the audio now; silence the mix so it is not heard twice.
    master.muted = true;
    const reMute = (): void => {
      if (!master.muted) master.muted = true;
    };
    const playAll = (): void => {
      for (const el of stemEls()) {
        el.currentTime = master.currentTime;
        void el.play().catch(() => {});
      }
    };
    const pauseAll = (): void => {
      for (const el of stemEls()) el.pause();
    };
    const alignAll = (): void => {
      for (const el of stemEls()) el.currentTime = master.currentTime;
    };
    const rateAll = (): void => {
      for (const el of stemEls()) el.playbackRate = master.playbackRate;
    };

    master.addEventListener('play', playAll);
    master.addEventListener('pause', pauseAll);
    master.addEventListener('seeking', alignAll);
    master.addEventListener('seeked', alignAll);
    master.addEventListener('ratechange', rateAll);
    master.addEventListener('volumechange', reMute);

    const drift = window.setInterval(() => {
      if (master.paused) return;
      for (const el of stemEls()) {
        if (el.paused) {
          el.currentTime = master.currentTime;
          void el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - master.currentTime) > 0.12) {
          el.currentTime = master.currentTime;
        }
      }
    }, 250);

    if (!master.paused) playAll();

    return () => {
      window.clearInterval(drift);
      master.removeEventListener('play', playAll);
      master.removeEventListener('pause', pauseAll);
      master.removeEventListener('seeking', alignAll);
      master.removeEventListener('seeked', alignAll);
      master.removeEventListener('ratechange', rateAll);
      master.removeEventListener('volumechange', reMute);
      pauseAll();
      master.muted = false;
    };
  }, [masterRef, stems]);

  // Apply the mute/solo state to the stem elements (solo overrides mute).
  useEffect(() => {
    for (const el of stemEls()) {
      const id = el.dataset.stem ?? '';
      el.muted = solo ? id !== solo : Boolean(muted[id]);
    }
  }, [muted, solo, stems]);

  const toggleMute = (id: string): void => setMuted((m) => ({ ...m, [id]: !m[id] }));
  const toggleSolo = (id: string): void => setSolo((s) => (s === id ? null : id));

  return (
    <div className="stem-mixer" ref={rootRef}>
      <div className="stem-mixer-head">
        <span className="stem-mixer-title">Stems</span>
        <span className="stem-mixer-hint">mute or solo individual instruments</span>
      </div>
      <div className="stem-list">
        {stems.map((stem) => {
          const effectiveMuted = solo ? stem.id !== solo : Boolean(muted[stem.id]);
          const isSolo = solo === stem.id;
          return (
            <div
              key={stem.id}
              className={`stem-row${effectiveMuted ? ' stem-row-muted' : ''}`}
            >
              <span className="stem-label">{stem.label}</span>
              <div className="stem-btns">
                <button
                  type="button"
                  className={`stem-btn${effectiveMuted ? '' : ' stem-btn-on'}`}
                  onClick={() => toggleMute(stem.id)}
                  aria-pressed={!effectiveMuted}
                  title={effectiveMuted ? 'Unmute' : 'Mute'}
                >
                  {effectiveMuted ? 'Muted' : 'On'}
                </button>
                <button
                  type="button"
                  className={`stem-btn stem-solo${isSolo ? ' stem-btn-on' : ''}`}
                  onClick={() => toggleSolo(stem.id)}
                  aria-pressed={isSolo}
                  title={isSolo ? 'Clear solo' : 'Solo this stem'}
                >
                  Solo
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {stems.map((stem) => (
        <audio key={stem.id} data-stem={stem.id} src={stem.url} preload="auto" />
      ))}
    </div>
  );
}
