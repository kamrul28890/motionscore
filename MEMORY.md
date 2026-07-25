# MotionScore — codebase map

A concise, accurate map of the repository for contributors and AI assistants.
Read this first, then jump to the files it points at. Keep it updated when the
architecture changes.

## What this is

A **web app** that turns an uploaded **audio file** into a **live 2D physics
visualization**. Audio is separated into real instruments by a neural model
(Demucs `htdemucs_6s`); each instrument drives a ball that strikes physical
lines exactly when it plays. Everything renders live on an HTML5 canvas, in sync
with the original audio used as the playback clock. No baked video, no MIDI, one
analysis path (neural stems).

## Monorepo shape

TypeScript, npm workspaces, `tsc -b`. Three packages:

| Package | Role |
|---|---|
| `@motionscore/types` | Shared data contracts + the one runtime validator. Zero deps on siblings. |
| `@motionscore/note-extractor` | Neural audio analysis: TS wrapper around a Python subprocess -> `AudioAnalysis`. Depends on `types`. |
| `@motionscore/web` | The product: Express API + React/Vite client with the live scene. Depends on `note-extractor` + `types`. |

Root config: `package.json` (workspaces = types, note-extractor, web),
`tsconfig.json` (references = types, note-extractor), `tsconfig.base.json`,
`vitest.config.ts`.

## End-to-end data flow

```
audio upload
  -> web POST /api/generate (packages/web/src/server.ts)
  -> analyzeAudio() (packages/note-extractor/src/index.ts)
       -> analyzeAudioEvents() (audio-events.ts) spawns Python:
            python/extract_stems.py (Demucs) + python/extract_events.py (DSP helpers)
       -> validated AudioAnalysis (packages/types/src/data-contracts.ts)
  -> SSE progress (/api/progress/:id); summary via summarizeAnalysis()
  -> client fetches /api/result/:id -> { durationSec, audioUrl, analysis, stems }
  -> scene2d.buildScene2D(analysis, settings) -> Scene2DModel
  -> scene2d.renderScene2D(ctx, model, frame) each rAF, clock = <audio>.currentTime
```

## `AudioAnalysis` (the central contract)

Defined in `packages/types/src/data-contracts.ts`. Key fields:

- `hits: NoteEvent[]` — discrete per-instrument onsets (id, startSec, velocity,
  `role`, salience). `role` is one of `HitRole`.
- `featureFrames` — 10 Hz full-mix loudness/bass/brightness/etc.
- `sectionCues` — build/drop/breakdown/rise/fall.
- `roleSignals?` — compact per-role neural timeline: `activityQ8` (0..255),
  `sustainSpans`, and for pitched roles `pitchDirection`/`pitchCoverageQ8`.
- `mode` is the literal `'stems'` (single-member union kept for self-description).

`HitRole` = kick | snare | percussion | bass | melodic | piano | guitar | vocal.
Role order/colours/labels live in the same file (`ROLE_ORDER`, `ROLE_COLORS`,
`ROLE_LABELS`) and are mirrored in the client at `packages/web/src/client/src/roleMeta.ts`.

`validateNoteEvents` (`packages/types/src/validators.ts`) is the only validator.

## Analyzer (packages/note-extractor)

- `src/index.ts` — public API: `analyzeAudio(path) -> AudioAnalysis`,
  `analyzeAudioWithSummary`, `summarizeAnalysis`, `detectStemsGpuAvailable`,
  `AUDIO_EXTENSIONS`.
- `src/audio-events.ts` — spawns the Python analyzer, enforces a timeout,
  strictly validates the JSON (events, feature frames, cues, and every
  `roleSignals` invariant), and builds the typed `AudioAnalysis`.
- `src/summary.ts` — `summarizeAnalysis()` projects `AudioAnalysis` into the
  compact `AudioAnalysisSummary` the UI shows (role counts, per-role activity
  strips, downsampled energy timeline).
- `python/extract_stems.py` — the analyzer: Demucs separation (CUDA w/ CPU
  fallback), per-stem onset detection, drums band-split into kick/snare/perc,
  and the `roleSignals` waveform activity/sustain/pitch signals. Emits one JSON.
  - Demucs config (audited against the official docs): `htdemucs_6s` (the only
    model with separate guitar/piano sources), `overlap=0.25`, `segment` left at
    the model default (Hybrid Transformer models cap at 7.8s, so forcing a larger
    value errors), and the shift trick left OFF (`shifts=0`): a single shift is a
    random-offset pass with no averaging gain and would only make separation
    non-deterministic; a real gain needs `shifts>=2` at proportional cost, not
    worth it for coarse onset/pitch analysis. `_separate` still takes the param
    so it can be raised for high-fidelity audio use.
  - **Pitch = real F0**, not brightness. Each isolated pitched stem is tracked
    with `librosa.pyin` (`_pyin_midi`, per-role `ROLE_F0_HZ` bounds, run at
    `PYIN_HOP` ~10.8 Hz to bound cost). `_octave_stabilize` folds pYIN octave
    glitches toward the local median so the ball follows the melody without
    darting an octave. That F0 drives both the per-onset `pitchMidi` and the
    `pitchDirection` (`_pitch_directions_from_midi`); unvoiced/untracked onsets
    fall back to the spectral-centroid estimate, so pitch never regresses. pYIN
    is the slowest step (analysis is meaningfully slower than separation alone).
  - **Onset activity gate** (`ONSET_ACTIVITY_FLOOR`): a pitched-stem onset is
    kept only where that stem's own normalized activity (`_native_activity`,
    shared with `_normalized_activity`) clears a floor. This rejects separation
    bleed (e.g. a loud guitar leaking into the "silent" vocal stem) that would
    otherwise spawn phantom onsets and yank a dormant ball back on-screen early.
  - **Stem audio export** (`_export_stems`, only when a 4th `stems_dir` arg is
    passed): writes each present whole stem as a mono MP3 (levels preserved,
    only hard-clipped) plus a `stems.json` manifest, for the web mute/solo mixer.
    kick/snare/perc are analysis-only band splits of the one `drums` stem, so
    only whole Demucs stems (drums/bass/vocals/guitar/piano/other) are playable.
- `python/extract_events.py` — **shared DSP helper module** imported by
  extract_stems.py (`import extract_events as ee`): STFT/HPSS feature analysis,
  feature-frame sampling, section-cue detection, peak picking, normalization.
  It has no standalone entry point (the old librosa modes were removed).

## Web server (packages/web/src/server.ts)

Audio-only, stems-only. Endpoints: `/api/generate`, `/api/progress/:id` (SSE),
`/api/result/:id` (`{ durationSec, audioUrl, analysis, stems }`), `/api/audio/:id`,
`/api/stem/:id/:name` (one separated-instrument mp3 for the mixer). Each job gets
a `stemsDir` (under the OS temp dir) passed to `analyzeAudio(path, { stemsDir })`;
after analysis the server reads `stems.json` (`readStemManifest`, path-traversal
guarded) and exposes `stems: [{ id, label, url }]` (labels via `STEM_LABELS`).
Jobs live in memory and are cleaned up after `CLEANUP_TTL_MS` (30 min) along with
the input and stems dir. Resolves the venv Python at boot (auto-detects `.venv`).
Calls `note-extractor` directly; there is no separate CLI/pipeline package.

## Windows desktop shell (desktop/main.mjs)

Electron starts the existing Express server on an ephemeral localhost port and
loads it into one secure `BrowserWindow` (`contextIsolation`, sandbox, no Node
integration). The shell locates the repository `.venv` for unpacked development
builds and points packaged builds at an analyzer copied outside `app.asar`.
`npm run desktop:dir` creates an unpacked Windows app; `npm run desktop:build`
creates the NSIS installer. The multi-gigabyte PyTorch/CUDA runtime is not
embedded and remains a separate distribution concern.

## Web client (packages/web/src/client)

- `src/App.tsx` — upload -> generate -> SSE -> fetch result -> render.
- `src/components/` — `FileUpload` (audio only), `ConfigForm` (just the Generate
  button), `ProgressDisplay` (named analyzer stages plus percent and messages),
  `AnalysisPanel` (role/energy/cue viz),
  `LiveScene` (canvas + `<audio>` clock + rAF loop), `RideControls`
  (drag-and-drop ball grouping, per-ball height/tilt/show-hide, one-click
  "Merge" for suggested pairs from `model.mergeSuggestions`, and "Reset
  positions" to clear manual overrides back to the auto layout), and `StemMixer`
  (source selection and individual component playback).
- `src/components/StemMixer.tsx` — the in-browser component player: renders one hidden
  `<audio>` per `result.stems` entry, keeps them locked to the mix `<audio>`
  (the transport + visual clock) by mirroring play/pause/seek/rate and a 250 ms
  drift correction. The user can A/B the original mix and separated components,
  listen to one stem, mute or solo stems, set independent volumes, and download
  exported MP3s. Rows also show detected-hit and pitch-coverage diagnostics.
  Falls back to the mix if no stems. kick/snare/perc are not separable (one
  drums stem).
- `src/components/LiveScene.tsx` keeps the visualization and master transport
  visible, then divides the editing workspace into two accessible tabs:
  **Source Lab** contains `StemMixer` plus `AnalysisPanel`; **Scene Controls**
  contains `RideControls`. Both tab panels remain mounted so audio and editing
  state survive tab changes.
- The always-visible visualization surface also owns Performance/Insight mode,
  reduced-motion preference, the live actor legend, a clickable full-song
  minimap, accessible scene narration, canvas actor hit-testing, and shared
  actor/stem focus. Selecting a ball or legend role solos its matching Demucs
  component; hovering a stem highlights the corresponding scene actor.
- `src/visualization-state.ts` contains the pure role-state, cue-selection,
  scene-description, and role-to-stem mapping functions used by those controls.
- `src/renderTypes.ts` — client-side mirror of the wire types (`AudioAnalysis`
  and its parts; `ResultPayload = { durationSec, audioUrl, analysis, stems? }`,
  `StemTrack`). Kept in sync with `@motionscore/types` by hand (the client is a
  standalone Vite bundle).

### The live scene — `src/client/src/scene2d/` (the visual core)

- `types.ts` — `Ctx2D` (the minimal canvas interface, so the module is
  framework-agnostic), `Actor`, `RaceContact`, ballistic/slide `RaceSegment`,
  `Scene2DModel`, `CameraState`.
- `settings.ts` — `Scene2DSettings` (roleVisible, `actorGroups`,
  `actorOverrides`), `DEFAULT_SCENE_SETTINGS`, helpers.
- `model.ts` — `buildScene2D(analysis, settings)`: groups roles into actors
  (default = one ball per sound; `DEFAULT_ROLE_ACTORS`), places music-fixed
  contacts, and solves motion backward — exact constant-gravity ballistic arcs
  (apex-bounded), neural-activity sustained cubic rails, phrase convergence,
  per-actor active-time clipping, manual override (bounded vertical shear +
  offset). Long silences: bleed-only sustain (no onset) is dropped, and a gap
  longer than ~`max(10 beats, 6s)` becomes a `dormantInterval` where the ball
  flies off-screen (top if the re-entry note is high, else bottom) and drops
  back in on the next onset — landing in a `catch` cradle. Pure/closed-form
  sampling: `sampleActor`, `sampleActorVelocity`, `sampleRaceSegment`,
  `sampleRaceVelocity`.
  - **Auto vertical layout** (`computeLaneCenters`): balls are ordered by
    register (highest median pitch on top, since +y is down) and the gap
    between neighbours is proportional to how far each kind swings
    (`laneHalfHeight`: rhythm < bass < lead), scaled to ~the old uniform
    footprint and zero-meaned. This de-crowds the scene without changing the
    camera zoom. It is the static default layout; manual Height/Tilt overrides
    stack on top of it.
  - **Merge suggestions** (`computeMergeSuggestions` -> `Scene2DModel.mergeSuggestions`):
    pairs of balls whose onsets nearly always coincide (within
    `min(0.08s, 0.2 beat)`) are surfaced so the user can merge them into one
    ball. Score = fraction of the sparser ball's onsets with a partner; only
    well-populated (>=12 onsets), confident (>=0.6) pairs, top 3, denser ball
    is the primary identity.
  - Pitched onsets map register to height (`(pitchMidi - median) * 0.1`) and
    sustained pitched material follows `pitchDirection`, so the rail traces the
    melody. Both rely on real per-stem F0 from the analyzer (see below); a fast
    articulated run stays a smooth rail (an earlier "bounce every onset" variant
    over-fired and was reverted).
  - Support spans are cleaned before use: `mergeSupportSpans` bridges brief
    articulation gaps (<= ~0.75 beat) into one rail, and `snapSpansToContacts`
    snaps a rail boundary onto a nearby onset. Together these stop a low/octave-
    misdetected onset next to a rail boundary from making a degenerate sub-frame
    segment whose velocity blows up (the "fall off the line and snap back" glitch).
- `render.ts` — `renderScene2D(ctx, model, frame)`: draws a section-aware paper
  background, then
  physical rails/catch bowls/contact lines, then solid balls; a trimmed-
  percentile fit camera that follows the active pack. Deterministic in
  `frame.timeSec`. Lines are tinted per ball via `lineColorFor(actor.color)` —
  hue preserved, luminance clamped so light balls stay legible on the paper; the
  ball keeps a dark ink outline over its colour fill.
- `index.ts` — public exports of the module.

Key invariants (see comments in `model.ts`/`render.ts`): every enabled onset is
represented; `x == timeSec*SCROLL_X + bias` and monotonic (manual tilt is a
bounded shear, never a rotation, so it can't force a zoom-out); contacts sit
exactly on the ball surface at their onset time; ballistic apexes are bounded
(no "infinite fall"); idle or long-silence-dormant actors are not framed by the
camera (it only frames on-stage balls).

## Setup / ops

- `scripts/setup.ps1` / `scripts/setup.sh` — the only setup: create `.venv`,
  install `librosa`, `torch`+`torchaudio` (CUDA default, `-Cpu`/`--cpu` flag),
  and `demucs`. Verifies the imports.
- Not in the public repo (gitignored): `.kiro/` (agent config), `docs/`
  (internal working notes / longer design history), `.venv/`, `music/`,
  `.tmp*/`. If something in `docs/` should be public, copy it out.

## Testing

- `vitest`. `packages/types/src/validators.test.ts` (property + unit tests for
  `validateNoteEvents`) and `test/smoke.test.ts`. The analyzer/scene are
  validated manually against real songs (they need the Python env / a browser).
- Client type-checking: the React client (`packages/web/src/client`, incl.
  `scene2d/**`) is checked by its own strict `tsconfig.json` via
  `npm run typecheck:client -w @motionscore/web`, which runs first inside
  `web:build`. (Root `tsc -b` only covers `types` + `note-extractor` + the web
  server; Vite/esbuild strips client types without checking them, so this script
  is what guards the client. `src/css.d.ts` declares the side-effect CSS import.)

## Conventions

- ESM everywhere; relative imports use explicit `.js` extensions (nodenext).
- Strict TypeScript. Avoid `any`.
- The scene renderer only uses `Ctx2D` (no DOM/React) so it stays portable and
  deterministic.
- When you change a wire type in `@motionscore/types`, update the client mirror
  in `renderTypes.ts` (and `roleMeta.ts` if role metadata changed).

## Common tasks

- **Change how balls move / look:** `scene2d/model.ts` (motion/planning) and
  `scene2d/render.ts` (drawing/camera).
- **Change grouping/controls UI:** `components/RideControls.tsx` + `settings.ts`.
- **Change the look / theme:** `packages/web/src/client/styles/app.css` — a single
  token-based dark theme (edit the `:root` tokens; the `--paper` token matches
  the canvas fill). Icons are inline SVGs, no icon font.
- **Change what the analyzer emits:** `python/extract_stems.py` (+ `extract_events.py`
  helpers), then the validator/types in `audio-events.ts` / `data-contracts.ts`.
- **Change API/progress:** `packages/web/src/server.ts` and the client
  `App.tsx` / `renderTypes.ts`.
