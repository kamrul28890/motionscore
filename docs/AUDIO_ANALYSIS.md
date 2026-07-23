# Audio Analysis Subsystem (Stage B)

This document is the reference for how MotionScore turns audio into hittable
events and scene-level cues. It reflects what is actually implemented today. For
the higher-level design rationale see `ARCHITECTURE.md` §4 (Stage B); for the
multi-ball roadmap that builds on this see `MULTI_BALL_PLAN.md`.

## Overview

Audio input is analyzed by a Python (librosa) subprocess that returns a single
JSON payload. The Node wrapper validates that payload and converts it into the
pipeline's data contracts. Two products come out of one analysis pass:

1. Discrete ball hits — `NoteEvent[]`, the events the ball strikes.
2. Scene-level data — a continuous feature timeline plus structural section
   cues (build/drop/breakdown/rise/fall). These do NOT create ball hits; they
   are inputs for camera/environment behavior in the renderer.

```
audio file
   |
   v
extract_events.py (librosa)          --> analysis.json  { version, durationSec, tempo, mode,
   | HPSS + low/mid/high onsets                            events[], featureFrames[], sectionCues[] }
   v
audio-events.ts  analyzeAudioEvents() --> validates JSON, builds typed AudioAnalysis
   |                                       (hits: NoteEvent[], featureFrames, sectionCues)
   v
note-extractor  extractWithAnalysis() --> { notes, audioAnalysis }
   |                                       (extract() still returns just NoteEvent[])
   v
cli/pipeline    runPipeline()          --> summarizes analysis, extends render to full duration
   |
   v
web             SSE complete event     --> AudioAnalysisSummary -> AnalysisPanel
```

## Modes

`extract(inputPath, { mode })` routes by file type and mode:

| Mode | Audio behavior | Notes |
|---|---|---|
| `auto` (default) | Smart stem-aware analysis (`smart`) | Recommended for songs |
| `beats` | librosa metrical pulse | Sparse; may omit fills/syncopation |
| `onsets` | All full-mix attacks | Denser, less selective than smart |
| `notes` | Basic Pitch transcription | Very dense; for sparse solo/pitched recordings |

MIDI input ignores `mode` and is parsed as exact notes. `auto` resolves to
`smart` for audio and to direct parsing for MIDI.

`smart`, `beats`, and `onsets` require Python + librosa. Only `notes` requires
Basic Pitch. Install the lightweight analyzer with `scripts/setup-audio.ps1`
(Windows) or `scripts/setup-audio.sh` (macOS/Linux); add Basic Pitch with
`scripts/setup-basic-pitch.*` only if you need `notes`. Point `PYTHON` at the
venv interpreter.

## Smart mode algorithm

Implemented in `packages/note-extractor/python/extract_events.py`.

1. STFT magnitude, then HPSS (`librosa.decompose.hpss`) to approximate a
   harmonic and a percussive spectrogram.
2. Onset-strength envelopes for the full mix, the percussive component, and the
   harmonic component. `onset_strength_multi` produces independent low / mid /
   high frequency-band envelopes for both HPSS components.
3. Frequency bands: low 20-180 Hz, mid 180-2000 Hz, high 2000 Hz-Nyquist.
4. Per-role envelopes are combined from those channels and peak-picked
   independently, producing candidate attacks for each role:
   - `kick` — percussive low band
   - `bass` — harmonic low band
   - `snare` — percussive mid band
   - `percussion` — percussive high band
   - `melodic` — harmonic mid/high band
5. Each candidate gets a `salience` (role strength + full-mix confirmation +
   a small on-beat bonus) and a `confidence`.
6. Candidates within `MERGE_WINDOW_SEC` are merged; the highest-ranked role
   wins the slot, and overlapping roles slightly boost salience/confidence.
7. Repetitive low-value hits (e.g. constant hi-hats) are suppressed, and a
   per-second cap keeps density sane.
8. A position hint is written into `pitchMidi` (a role base, slew-limited so it
   cannot jump across the screen between close events). For mixed audio this is
   a choreography hint, not a real pitch.

`beats` and `onsets` reuse the same envelopes/roles but select events from the
beat tracker or the full-mix onset detector respectively, so they remain useful
comparison baselines.

### Tuning constants (Python)

| Constant | Value | Meaning |
|---|---|---|
| `SAMPLE_RATE` | 22050 | Analysis sample rate |
| `N_FFT` / `HOP_LENGTH` | 2048 / 512 | STFT window / hop (~23 ms frames) |
| `FEATURE_RATE_HZ` | 10 | Feature-frame timeline rate |
| `MERGE_WINDOW_SEC` | 0.095 | Simultaneous-hit merge window |
| `MIN_HIT_GAP_SEC` | 0.09 | Minimum spacing between kept hits |
| `MAX_HITS_PER_SECOND` | 8 | Density safety cap |
| `MAX_AUDIO_DURATION_SEC` | 720 | Hard input limit (12 min); longer input is rejected |

The duration limit bounds decoded-audio and spectrogram memory. Split longer
mixes before analysis.

## Continuous features and section cues

A feature frame is emitted every 0.1 s with normalized `loudness`, `bassEnergy`,
`brightness`, `onsetDensity`, `harmonicEnergy`, and `percussiveEnergy`.

Section cues are derived from smoothed energy/bass/density/brightness trends:

- `build` — rising energy with growing onset density; ended exactly on a drop
  when one follows, giving offline rendering lookahead.
- `drop` — a broadband + bass jump after a quieter window, aligned to the
  transient edge; emitted with a cooldown so one transition yields one cue.
- `breakdown` — a sustained fall into a low-energy section.
- `rise` / `fall` — gentler upward/downward trends.

These are intentionally not ball hits. They are the hooks for camera moves,
environment vibration, long pre-drop suspension, and lighting once the renderer
consumes them.

## JSON schema (Python -> Node)

```json
{
  "version": 1,
  "durationSec": 182.4,
  "tempo": 128.0,
  "mode": "smart",
  "events": [
    { "timeSec": 1.203, "pitchMidi": 60, "velocity": 0.82,
      "role": "kick", "confidence": 0.91, "salience": 0.88 }
  ],
  "featureFrames": [
    { "timeSec": 0.1, "loudness": 0.54, "bassEnergy": 0.61, "brightness": 0.42,
      "onsetDensity": 0.35, "harmonicEnergy": 0.48, "percussiveEnergy": 0.67 }
  ],
  "sectionCues": [
    { "type": "drop", "startSec": 44.0, "endSec": 44.5, "peakSec": 44.0,
      "intensity": 0.9, "confidence": 0.85 }
  ]
}
```

The Node wrapper (`audio-events.ts`) treats this payload as untrusted: it
rejects a wrong `version`, a `mode` mismatch, missing arrays, and out-of-range
or non-finite required fields with a `TranscriptionError` rather than silently
defaulting. The analyzer subprocess also has a 15-minute watchdog timeout.

## Node data contracts

`analyzeAudioEvents()` returns the rich `AudioAnalysis`:

```ts
interface AudioAnalysis {
  version: 1;
  durationSec: number;
  tempoBpm: number;
  mode: 'smart' | 'beats' | 'onsets';
  hits: NoteEvent[];
  featureFrames: AudioFeatureFrame[];
  sectionCues: SectionCue[];
}
```

`NoteEvent` gained optional fields, all backward-compatible with MIDI:

```ts
interface NoteEvent {
  id: string; pitchMidi: number; startSec: number; endSec: number; velocity: number;
  source?: 'midi' | 'audio';   // provenance; audio enables choreography hints
  role?: 'kick' | 'bass' | 'snare' | 'percussion' | 'melodic';
  confidence?: number;         // [0,1]
  salience?: number;           // [0,1] musical importance
  track?: string; instrument?: string;
}
```

`source` is the important discriminator: the mapper only applies audio-only
lane/slew choreography hints when `source === 'audio'`, so a role-tagged MIDI
event still maps by exact pitch.

`extract()` still returns `NoteEvent[]` for backward compatibility.
`extractWithAnalysis()` returns `{ notes, audioAnalysis? }` so the pipeline can
use the source duration and (later) the cues.

## Pipeline integration

`runPipeline` (in `packages/cli/src/pipeline.ts`):

- calls `extractWithAnalysis`, so it has the analyzed source duration;
- extends the solved trajectory with a terminal hold to the full source
  duration, so the video no longer ends on the last hit while audio continues;
- builds a compact `AudioAnalysisSummary` and returns it in `PipelineResult`;
- the CLI prints mode/tempo/hit-count/roles/cue counts on success.

```ts
interface AudioAnalysisSummary {
  mode: 'smart' | 'beats' | 'onsets';
  tempoBpm: number;
  durationSec: number;
  hitCount: number;
  roleCounts: Record<HitRole, number>;
  sectionCues: SectionCue[];
  energyTimeline: { timeSec: number; loudness: number; bassEnergy: number }[]; // <=160 pts
}
```

The full 10 Hz feature frames stay server-side; only the downsampled
`energyTimeline` is sent to the browser.

## Web integration

- `POST /api/generate` accepts `mode` (`auto|beats|onsets|notes`).
- The pipeline's verbose stage logs are parsed into SSE progress events. Stage
  percentages match the real emitted stage names, and the streaming
  `render + encode` stage advances 42%->98% from `render+encode progress: N/M`
  lines (previously it sat at 0%). The client uses the last defined percent so
  interleaved messages never reset the bar.
- The SSE `complete` event carries `AudioAnalysisSummary`, rendered by
  `AnalysisPanel` (tempo, hits, role histogram, an SVG energy timeline with drop
  markers, and a section-cue list). The panel notes that cues are detected but
  not yet animated.

## Files

| File | Responsibility |
|---|---|
| `packages/note-extractor/python/extract_events.py` | librosa HPSS/onset analysis, roles, merging, features, cues |
| `packages/note-extractor/src/audio-events.ts` | subprocess, strict JSON validation, timeout, contract conversion |
| `packages/note-extractor/src/index.ts` | `extract` / `extractWithAnalysis` routing |
| `packages/types/src/data-contracts.ts` | `NoteEvent`, `AudioAnalysis`, `AudioAnalysisSummary`, `SectionCue`, ... |
| `packages/types/src/validators.ts` | runtime validation of the above |
| `packages/cli/src/pipeline.ts` | analysis summary + full-duration render hold |
| `packages/web/src/server.ts` | mode validation, SSE progress + analysis forwarding |
| `packages/web/src/client/src/components/AnalysisPanel.tsx` | analysis visualization |
| `scripts/setup-audio.*` | lightweight librosa setup |
