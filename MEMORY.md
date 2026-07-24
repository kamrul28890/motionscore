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
  -> client fetches /api/result/:id -> { durationSec, audioUrl, analysis }
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
- `python/extract_events.py` — **shared DSP helper module** imported by
  extract_stems.py (`import extract_events as ee`): STFT/HPSS feature analysis,
  feature-frame sampling, section-cue detection, peak picking, normalization.
  It has no standalone entry point (the old librosa modes were removed).

## Web server (packages/web/src/server.ts)

Audio-only, stems-only. Endpoints: `/api/generate`, `/api/progress/:id` (SSE),
`/api/result/:id` (`{ durationSec, audioUrl, analysis }`), `/api/audio/:id`.
Jobs live in memory and are cleaned up after `CLEANUP_TTL_MS` (30 min). Resolves
the venv Python at boot (auto-detects `.venv`). Calls `note-extractor` directly;
there is no separate CLI/pipeline package.

## Web client (packages/web/src/client)

- `src/App.tsx` — upload -> generate -> SSE -> fetch result -> render.
- `src/components/` — `FileUpload` (audio only), `ConfigForm` (just the Generate
  button), `ProgressDisplay`, `AnalysisPanel` (role/energy/cue viz),
  `LiveScene` (canvas + `<audio>` clock + rAF loop), `RideControls`
  (drag-and-drop ball grouping, per-ball height/tilt/show-hide).
- `src/renderTypes.ts` — client-side mirror of the wire types (`AudioAnalysis`
  and its parts; `ResultPayload = { durationSec, audioUrl, analysis }`). Kept in
  sync with `@motionscore/types` by hand (the client is a standalone Vite bundle).

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
  per-actor active-time clipping, manual override shear/offset. Pure/closed-form
  sampling: `sampleActor`, `sampleActorVelocity`, `sampleRaceSegment`,
  `sampleRaceVelocity`.
- `render.ts` — `renderScene2D(ctx, model, frame)`: draws paper background,
  black physical rails/catch bowls/contact lines, then solid balls; a
  trimmed-percentile fit camera that follows the active pack. Deterministic in
  `frame.timeSec`.
- `index.ts` — public exports of the module.

Key invariants (see comments in `model.ts`/`render.ts`): every enabled onset is
represented; `x == timeSec*SCROLL_X + bias` and monotonic; contacts sit exactly
on the ball surface at their onset time; ballistic apexes are bounded (no
"infinite fall"); idle actors are neither drawn nor allowed to drag the camera.

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
- **Change what the analyzer emits:** `python/extract_stems.py` (+ `extract_events.py`
  helpers), then the validator/types in `audio-events.ts` / `data-contracts.ts`.
- **Change API/progress:** `packages/web/src/server.ts` and the client
  `App.tsx` / `renderTypes.ts`.
