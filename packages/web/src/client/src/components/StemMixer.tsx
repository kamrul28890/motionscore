import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import type { AudioAnalysis, HitRole, StemTrack } from '../renderTypes.js';

interface StemMixerProps {
  /** The mix <audio> element owns transport and the visualization clock. */
  masterRef: RefObject<HTMLAudioElement | null>;
  stems: StemTrack[];
  analysis: AudioAnalysis | null;
}

type PlaybackSource = 'mix' | 'components';

const STEM_ROLES: Record<string, readonly HitRole[]> = {
  drums: ['kick', 'snare', 'percussion'],
  bass: ['bass'],
  vocals: ['vocal'],
  guitar: ['guitar'],
  piano: ['piano'],
  other: ['melodic'],
};

const STEM_COLORS: Record<string, string> = {
  drums: '#ef476f',
  bass: '#ffa94d',
  vocals: '#a9e34b',
  guitar: '#f783ac',
  piano: '#b197fc',
  other: '#4dabf7',
};

interface StemDiagnostic {
  hitCount: number;
  pitchCoverage: number | null;
}

function diagnosticsForStem(stemId: string, analysis: AudioAnalysis | null): StemDiagnostic {
  if (!analysis) return { hitCount: 0, pitchCoverage: null };
  const roles = STEM_ROLES[stemId] ?? [];
  const roleSet = new Set<HitRole>(roles);
  const hitCount = analysis.hits.filter(
    (hit) => hit.role !== undefined && roleSet.has(hit.role),
  ).length;
  const coverages = (analysis.roleSignals?.tracks ?? [])
    .filter((track) => roleSet.has(track.role) && track.pitchCoverageQ8 !== undefined)
    .map((track) => track.pitchCoverageQ8! / 255);
  const pitchCoverage =
    coverages.length > 0
      ? coverages.reduce((sum, value) => sum + value, 0) / coverages.length
      : null;
  return { hitCount, pitchCoverage };
}

/**
 * Component player for Demucs stems. The original mix remains the transport and
 * visualization clock. Hidden stem elements mirror its play/pause/seek/rate,
 * while this panel switches audibly between the original and separated sources.
 */
export function StemMixer({ masterRef, stems, analysis }: StemMixerProps) {
  const [source, setSource] = useState<PlaybackSource>('components');
  const [muted, setMuted] = useState<Record<string, boolean>>({});
  const [solo, setSolo] = useState<string | null>(null);
  const [volumes, setVolumes] = useState<Record<string, number>>({});
  const [isPlaying, setIsPlaying] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const stemEls = useCallback(
    (): HTMLAudioElement[] =>
      rootRef.current
        ? Array.from(rootRef.current.querySelectorAll<HTMLAudioElement>('audio[data-stem]'))
        : [],
    [],
  );

  const diagnostics = useMemo(
    () =>
      Object.fromEntries(
        stems.map((stem) => [stem.id, diagnosticsForStem(stem.id, analysis)]),
      ) as Record<string, StemDiagnostic>,
    [analysis, stems],
  );

  // Mirror the master transport onto every component and correct audible drift.
  useEffect(() => {
    const master = masterRef.current;
    if (!master) return;

    const playAll = (): void => {
      setIsPlaying(true);
      for (const el of stemEls()) {
        el.currentTime = master.currentTime;
        el.playbackRate = master.playbackRate;
        void el.play().catch(() => {});
      }
    };
    const pauseAll = (): void => {
      setIsPlaying(false);
      for (const el of stemEls()) el.pause();
    };
    const alignAll = (): void => {
      for (const el of stemEls()) el.currentTime = master.currentTime;
    };
    const rateAll = (): void => {
      for (const el of stemEls()) el.playbackRate = master.playbackRate;
    };

    setIsPlaying(!master.paused);
    master.addEventListener('play', playAll);
    master.addEventListener('pause', pauseAll);
    master.addEventListener('ended', pauseAll);
    master.addEventListener('seeking', alignAll);
    master.addEventListener('seeked', alignAll);
    master.addEventListener('ratechange', rateAll);

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
      master.removeEventListener('ended', pauseAll);
      master.removeEventListener('seeking', alignAll);
      master.removeEventListener('seeked', alignAll);
      master.removeEventListener('ratechange', rateAll);
      pauseAll();
      master.muted = false;
    };
  }, [masterRef, stemEls, stems]);

  // Apply source selection, mute/solo, and independent component volumes.
  useEffect(() => {
    const master = masterRef.current;
    if (!master) return;
    const applyMixState = (): void => {
      master.muted = source === 'components';
    };
    applyMixState();
    master.addEventListener('volumechange', applyMixState);

    for (const el of stemEls()) {
      const id = el.dataset.stem ?? '';
      const effectiveMuted =
        source === 'mix' || (solo ? id !== solo : Boolean(muted[id]));
      el.muted = effectiveMuted;
      el.volume = volumes[id] ?? 1;
    }

    return () => {
      master.removeEventListener('volumechange', applyMixState);
    };
  }, [masterRef, muted, solo, source, stemEls, stems, volumes]);

  const toggleMute = (id: string): void => {
    setSource('components');
    setMuted((current) => ({ ...current, [id]: !current[id] }));
  };

  const toggleSolo = (id: string): void => {
    setSource('components');
    setSolo((current) => (current === id ? null : id));
  };

  const listenToStem = (id: string): void => {
    const master = masterRef.current;
    if (!master) return;
    setSource('components');
    setMuted((current) => ({ ...current, [id]: false }));
    if (solo === id && source === 'components') {
      if (master.paused) void master.play().catch(() => {});
      else master.pause();
      return;
    }
    setSolo(id);
    if (master.paused) void master.play().catch(() => {});
  };

  const changeVolume = (id: string, value: number): void => {
    setSource('components');
    setVolumes((current) => ({ ...current, [id]: value }));
    if (value > 0) setMuted((current) => ({ ...current, [id]: false }));
  };

  return (
    <section className="stem-mixer" ref={rootRef} aria-labelledby="component-player-title">
      <div className="stem-mixer-head">
        <div>
          <div className="stem-title-line">
            <span className="stem-eyebrow">Source lab</span>
            <span className="stem-count">{stems.length} components</span>
          </div>
          <h3 id="component-player-title">Listen inside the song</h3>
          <p>
            Compare the original mix or isolate the neural components while the
            visualization stays locked to the same timeline.
          </p>
        </div>

        <div className="source-switch" role="group" aria-label="Playback source">
          <button
            type="button"
            className={source === 'mix' ? 'source-option source-option-active' : 'source-option'}
            onClick={() => setSource('mix')}
            aria-pressed={source === 'mix'}
          >
            Original mix
          </button>
          <button
            type="button"
            className={
              source === 'components' ? 'source-option source-option-active' : 'source-option'
            }
            onClick={() => setSource('components')}
            aria-pressed={source === 'components'}
          >
            Components
          </button>
        </div>
      </div>

      <div className="stem-mode-note" aria-live="polite">
        <span className={`source-led source-led-${source}`} aria-hidden="true" />
        {source === 'mix'
          ? 'Playing the untouched uploaded mix.'
          : solo
            ? `Listening only to ${stems.find((stem) => stem.id === solo)?.label ?? solo}.`
            : 'Playing the sum of every enabled component.'}
      </div>

      <div className="stem-list">
        {stems.map((stem) => {
          const componentMuted = solo ? stem.id !== solo : Boolean(muted[stem.id]);
          const isSolo = solo === stem.id;
          const isListening = source === 'components' && isSolo && isPlaying;
          const volume = volumes[stem.id] ?? 1;
          const diagnostic = diagnostics[stem.id] ?? { hitCount: 0, pitchCoverage: null };
          const color = STEM_COLORS[stem.id] ?? '#4d84ff';
          const downloadUrl = `${stem.url}${stem.url.includes('?') ? '&' : '?'}download=1`;

          return (
            <article
              key={stem.id}
              className={`stem-row${componentMuted ? ' stem-row-muted' : ''}${
                isSolo ? ' stem-row-solo' : ''
              }`}
            >
              <div className="stem-identity">
                <span className="stem-color" style={{ background: color }} aria-hidden="true" />
                <div className="stem-copy">
                  <strong>{stem.label}</strong>
                  <span>
                    {diagnostic.hitCount} detected hits
                    {diagnostic.pitchCoverage !== null
                      ? ` · ${Math.round(diagnostic.pitchCoverage * 100)}% pitch coverage`
                      : ''}
                  </span>
                </div>
              </div>

              <div className="stem-actions">
                <button
                  type="button"
                  className={`stem-listen${isListening ? ' stem-listen-active' : ''}`}
                  onClick={() => listenToStem(stem.id)}
                  aria-label={`${isListening ? 'Pause' : 'Listen to'} ${stem.label}`}
                  title={`${isListening ? 'Pause' : 'Listen to'} ${stem.label}`}
                >
                  <span aria-hidden="true">{isListening ? '❚❚' : '▶'}</span>
                </button>

                <label className="stem-volume">
                  <span className="sr-only">{stem.label} volume</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={volume}
                    onChange={(event) => changeVolume(stem.id, Number(event.target.value))}
                    style={{ '--stem-level': `${volume * 100}%` } as CSSProperties}
                  />
                  <output>{Math.round(volume * 100)}%</output>
                </label>

                <div className="stem-btns">
                  <button
                    type="button"
                    className={`stem-btn${muted[stem.id] ? ' stem-btn-muted' : ''}`}
                    onClick={() => toggleMute(stem.id)}
                    aria-pressed={Boolean(muted[stem.id])}
                    title={muted[stem.id] ? `Unmute ${stem.label}` : `Mute ${stem.label}`}
                  >
                    {muted[stem.id] ? 'Muted' : 'Mute'}
                  </button>
                  <button
                    type="button"
                    className={`stem-btn stem-solo${isSolo ? ' stem-btn-on' : ''}`}
                    onClick={() => toggleSolo(stem.id)}
                    aria-pressed={isSolo}
                    title={isSolo ? `Clear ${stem.label} solo` : `Solo ${stem.label}`}
                  >
                    Solo
                  </button>
                  <a
                    className="stem-download"
                    href={downloadUrl}
                    download={`${stem.id}.mp3`}
                    aria-label={`Download ${stem.label}`}
                    title={`Download ${stem.label}`}
                  >
                    Download
                  </a>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <p className="stem-footnote">
        Kick, snare, and percussion are detected inside the combined Drums component;
        Demucs does not export them as separate audio files.
      </p>

      {stems.map((stem) => (
        <audio key={stem.id} data-stem={stem.id} src={stem.url} preload="metadata" />
      ))}
    </section>
  );
}
