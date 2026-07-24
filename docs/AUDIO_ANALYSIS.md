# Audio Analysis Subsystem (Stage B)

Last updated: 2026-07-23. This document describes the implemented audio analyzers and their current Node contracts.

## 1. Outputs

An audio analysis produces three kinds of information with deliberately separate semantics:

1. **Discrete hits** — accepted onsets converted one-to-one into `NoteEvent[]`. These are exact physical contact obligations.
2. **Full-mix scene features** — 10 Hz loudness, bass, brightness, density, harmonic, and percussive values plus structural section cues.
3. **Neural role signals** — optional 10 Hz per-role waveform activity, sustain regions, and pitched-register direction from accepted Demucs stems.

A continuous signal never creates or replaces a discrete hit. It tells choreography when support can exist between hits.

```text
                         +-> extract_events.py (smart/beats/onsets)
audio -> mode routing --|
                         +-> extract_stems.py (Demucs stems)
                                  |
                                  +-> reuses full-mix features/cues
                                  +-> per-stem hits + roleSignals
                                           |
                                           v
                         audio-events.ts strict validation
                                           |
                                           v
                         AudioAnalysis + one-to-one NoteEvent[]
                                           |
                         +-----------------+------------------+
                         |                                    |
                  CLI/UI summary                     live scene2d planner
```

## 2. Modes and routing

| Mode | Audio behavior | Intended use |
|---|---|---|
| `auto` | Context-dependent; see below | Default UX |
| `smart` | librosa HPSS + multi-band role-aware onsets | Lightweight mixed-song analysis |
| `beats` | librosa metrical pulses | Sparse comparison mode |
| `onsets` | full-mix attack detection | Dense comparison mode |
| `notes` | Basic Pitch transcription | Sparse solo/pitched recordings |
| `stems` | Demucs `htdemucs_6s`, per-instrument events and signals | Highest role identity |

MIDI bypasses audio analysis and is parsed directly.

`auto` has two intentional meanings:

- **CLI:** resolves to `smart`; use `--mode stems` to request neural separation explicitly.
- **Web:** probes the configured Python environment. If PyTorch + Demucs are installed and CUDA is available, it resolves to `stems`; otherwise it resolves to `smart`.

This keeps command-line behavior predictable while letting the local web app use the installed GPU automatically.

Dependencies:

- `smart` / `beats` / `onsets`: Python + librosa;
- `notes`: Basic Pitch;
- `stems`: PyTorch + Demucs (GPU recommended, CPU supported).

Use `scripts/setup-audio.ps1` or `.sh` for the lightweight analyzer and `scripts/setup-demucs.ps1` or `.sh` for neural stems. Set `PYTHON` to the desired interpreter, e.g. `.\.venv\Scripts\python.exe` on Windows.

## 3. Lightweight analyzer

Implemented in `packages/note-extractor/python/extract_events.py`.

### Smart mode

1. Decode at 22,050 Hz and compute an STFT.
2. Use HPSS to approximate harmonic and percussive components.
3. Build full-mix and independent low/mid/high onset-strength envelopes.
4. Form role candidates:
   - kick: percussive low band;
   - bass: harmonic low band;
   - snare: percussive mid band;
   - percussion: percussive high band;
   - melodic: harmonic mid/high band.
5. Score each candidate with role strength, full-mix confirmation, salience, confidence, and a small metrical bonus.
6. Merge near-simultaneous candidates according to the lightweight analyzer's perceptual merge policy and enforce its minimum retrigger spacing.
7. Emit a role-based `pitchMidi` choreography hint. It is not a literal pitch claim for drum transients.

The former fixed `MAX_HITS_PER_SECOND=8` cap has been removed. Density now emerges from onset peak selection, `MERGE_WINDOW_SEC`, and `MIN_HIT_GAP_SEC`; there is no separate per-second truncation pass.

`beats` and `onsets` share the feature/role machinery but select timestamps from the beat tracker or full-mix onset detector.

### Main constants

| Constant | Value | Purpose |
|---|---:|---|
| `SAMPLE_RATE` | 22050 | analysis sample rate |
| `N_FFT` / `HOP_LENGTH` | 2048 / 512 | spectral window/hop |
| `FEATURE_RATE_HZ` | 10 | feature timeline rate |
| `MERGE_WINDOW_SEC` | 0.095 | perceptual simultaneous-candidate merge |
| `MIN_HIT_GAP_SEC` | 0.09 | analyzer retrigger spacing |
| `MAX_AUDIO_DURATION_SEC` | 720 | decoded-audio/spectrogram memory guard |

The 12-minute duration guard rejects longer input; split longer files before analysis.

## 4. Neural stems analyzer

Implemented in `packages/note-extractor/python/extract_stems.py`.

### 4.1 Separation and presence gating

Demucs `htdemucs_6s` separates `drums`, `bass`, `other`, `vocals`, `guitar`, and `piano`. CUDA is used when available; a CUDA runtime failure falls back to CPU.

Each separated waveform is measured before downstream normalization. A stem is accepted only when its RMS clears both an absolute floor and a fraction of the loudest stem:

| Constant | Value | Purpose |
|---|---:|---|
| `STEM_PRESENCE_REL` | 0.12 | fraction of loudest stem RMS |
| `STEM_PRESENCE_ABS` | `5e-4` | absolute RMS floor |

This prevents near-silent bleed from becoming hundreds of phantom onsets after per-stem normalization.

### 4.2 Discrete events

Accepted non-drum stems map directly:

- bass -> `bass`;
- other -> `melodic`;
- vocals -> `vocal`;
- guitar -> `guitar`;
- piano -> `piano`.

The drums stem is split spectrally into kick, snare, and percussion onset streams. Pitched stems use spectral information to provide a register-oriented `pitchMidi` hint. Per-role peak-picking sensitivity and minimum spacing belong to onset extraction itself; once an event is emitted, TypeScript preserves it.

Relevant constants:

| Constant | Value | Purpose |
|---|---:|---|
| `MODEL_NAME` | `htdemucs_6s` | six-source Demucs model |
| `ROLE_MIN_GAP` | `0.09 s` | per-role neural onset retrigger spacing |
| `ROLE_DELTA` | `0.06–0.09` | role-specific peak-pick sensitivity |

### 4.3 Continuous `roleSignals`

The accepted separated waveforms also produce a compact timeline at 10 Hz. This is not onset-derived activity: it comes from the role waveform/spectrum, so held bass, guitar, piano, melodic, and vocal material remains visible between attacks.

For every canonical role, the extractor emits:

- normalized smoothed activity quantized to Q8 (`0..255`);
- sorted sustain spans on the shared frame grid;
- for pitched roles, median-smoothed register direction (`-1`, `0`, `1`) and Q8 pitch-estimate coverage.

The canonical track order is:

```text
kick, snare, percussion, bass, melodic, piano, guitar, vocal
```

Tracks for absent roles are present but contain zero activity and no sustains. This fixed shape simplifies validation and deterministic grouping.

### 4.4 Full-mix features

Stems mode reuses `extract_events.py` for full-mix feature frames and section cues, but its payload is **not byte-identical** to lightweight mode: it additionally includes `roleSignals` and uses per-stem events.

## 5. Python JSON payload

Representative stems payload (arrays abbreviated):

```json
{
  "version": 1,
  "durationSec": 182.4,
  "tempo": 128.0,
  "mode": "stems",
  "events": [
    {
      "timeSec": 1.203,
      "pitchMidi": 60,
      "velocity": 0.82,
      "role": "kick",
      "confidence": 0.91,
      "salience": 0.88
    }
  ],
  "featureFrames": [
    {
      "timeSec": 0.1,
      "loudness": 0.54,
      "bassEnergy": 0.61,
      "brightness": 0.42,
      "onsetDensity": 0.35,
      "harmonicEnergy": 0.48,
      "percussiveEnergy": 0.67
    }
  ],
  "sectionCues": [
    {
      "type": "drop",
      "startSec": 44.0,
      "endSec": 44.5,
      "peakSec": 44.0,
      "intensity": 0.9,
      "confidence": 0.85
    }
  ],
  "roleSignals": {
    "version": 1,
    "frameRateHz": 10,
    "frameCount": 1824,
    "tracks": [
      {
        "role": "kick",
        "activityQ8": [0, 18, 240],
        "sustainSpans": [[1, 3]]
      },
      {
        "role": "bass",
        "activityQ8": [0, 96, 180],
        "sustainSpans": [[1, 3]],
        "pitchDirection": [0, 1, 1],
        "pitchCoverageQ8": 231
      }
    ]
  }
}
```

The abbreviated example omits the remaining canonical tracks and most frame values; real payloads contain all eight tracks and arrays exactly `frameCount` long.

## 6. Node validation and contracts

`packages/note-extractor/src/audio-events.ts` treats the subprocess result as untrusted. Invalid output becomes a `TranscriptionError` rather than being defaulted silently.

For `roleSignals`, validation requires:

- `version === 1`;
- `frameRateHz === 10`;
- `frameCount === featureFrames.length`;
- exactly eight tracks in canonical `ROLE_ORDER`;
- each `activityQ8` length equals `frameCount`, with integer values `0..255`;
- spans are integer, in range, ordered, and non-overlapping;
- pitch-direction arrays have the same frame count and contain only `-1|0|1`;
- pitch fields appear only on bass, melodic, piano, guitar, or vocal;
- pitch coverage is an integer `0..255`.

The shared contract is additive:

```ts
type PitchDirection = -1 | 0 | 1;
type SustainSpan = [startFrame: number, endFrame: number];

interface RoleSignalTrack {
  role: HitRole;
  activityQ8: number[];
  sustainSpans: SustainSpan[];
  pitchDirection?: PitchDirection[];
  pitchCoverageQ8?: number;
}

interface RoleSignals {
  version: 1;
  frameRateHz: number;
  frameCount: number;
  tracks: RoleSignalTrack[];
}

interface AudioAnalysis {
  version: 1;
  durationSec: number;
  tempoBpm: number;
  mode: AudioAnalysisMode;
  hits: NoteEvent[];
  featureFrames: AudioFeatureFrame[];
  sectionCues: SectionCue[];
  roleSignals?: RoleSignals;
}
```

Non-stems modes omit `roleSignals` and remain backward-compatible.

## 7. One-to-one hit conversion

After the raw payload passes validation, `buildNoteEvents()`:

1. filters only invalid/non-finite negative timestamps;
2. stable-sorts by `timeSec`;
3. maps every remaining raw event to one sequentially identified `NoteEvent`;
4. carries role, confidence, salience, velocity, and choreography pitch hint.

There is no TypeScript `MIN_EVENT_GAP_SEC`, priority function, role-aware thinning, or event-count cap. If several accepted events are exactly co-timed, all remain in `AudioAnalysis.hits`. The race planner may give same-group co-timed notes one physical contact, but that contact stores all note IDs, preserving representation.

## 8. Full-mix features and section cues

A feature frame is emitted every 0.1 seconds with normalized:

- `loudness`;
- `bassEnergy`;
- `brightness`;
- `onsetDensity`;
- `harmonicEnergy`;
- `percussiveEnergy`.

Section cues are derived from trends relative to the track's own distribution rather than fixed loudness thresholds:

- `drop`: dip-to-high-energy transition, bass-confirmed;
- `build`: rising trend leading into high energy/drop;
- `breakdown`: sustained move into low energy;
- `rise` / `fall`: gentler sustained trends.

They are structural hints, not ball hits. The current race treats discrete role events and neural sustains as primary truth, using cues only for longer phrase shaping where appropriate.

## 9. Pipeline and UI summaries

`runPipeline()` returns both the full `AudioAnalysis` for the live scene and a compact `AudioAnalysisSummary` for UI/status reporting.

`roleActivity` contains `ROLE_ACTIVITY_BINS` normalized values per role:

- stems mode with `roleSignals`: bins waveform activity, retaining held material;
- other modes or older payloads: bins event velocity by onset as fallback.

Each role is normalized against its own peak so the strip shows when it participates rather than comparing absolute stem loudness. The summary also contains tempo, duration, hit count, role counts, section cues, and a downsampled energy timeline.

## 10. Web integration

- `POST /api/generate` accepts `auto|beats|onsets|notes|stems`. `smart` is the lightweight analyzer selected by `auto`, not a separate web form value.
- Full analysis is available from `/api/result/:jobId`; the source audio is served through `/api/audio/:jobId` for deterministic live playback.
- The analysis panel displays role counts/activity, energy, and cues.
- `LiveScene` consumes full hits and `roleSignals` to build the semantic race. Role visibility is explicit; there is no hidden “busiest roles” cap.

## 11. Known limitations

- `smart`/`beats`/`onsets` role labels are HPSS/frequency-band heuristics. Use `stems` when instrument identity matters.
- Demucs separation can still leak sources; presence gating handles near-silent bleed but cannot make overlapping instruments perfectly isolated.
- Neural onset density is intentionally preserved downstream. Visual cleanup must happen through adaptive geometry/grouping, not silent event deletion.
- Cue detection is energy/trend-based rather than semantic song-form understanding.
- The input-duration guard and subprocess watchdog are resource/safety boundaries, not musical-density caps.

## 12. Files

| File | Responsibility |
|---|---|
| `packages/note-extractor/python/extract_events.py` | librosa modes, features, cues |
| `packages/note-extractor/python/extract_stems.py` | Demucs separation, per-role events, waveform signals |
| `packages/note-extractor/src/audio-events.ts` | subprocess routing, strict validation, one-to-one conversion |
| `packages/note-extractor/src/index.ts` | public extract APIs |
| `packages/types/src/data-contracts.ts` | shared event/analysis/role-signal contracts |
| `packages/cli/src/pipeline.ts` | full analysis forwarding and compact summaries |
| `packages/web/src/server.ts` | web mode selection and result/audio endpoints |
| `packages/web/src/client/src/components/AnalysisPanel.tsx` | compact analysis visualization |
| `packages/web/src/client/src/scene2d/model.ts` | role-signal-driven race planner |
| `scripts/setup-audio.*` | lightweight environment setup |
| `scripts/setup-demucs.*` | neural environment setup |
