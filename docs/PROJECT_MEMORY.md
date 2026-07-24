# Project Memory (quick resume)

Last updated: 2026-07-23. This file is the current source of truth for the implemented system; discarded fixed-lane, impulse, and R3F experiments are summarized under **Superseded designs** rather than described as current behavior.

## What this is

MotionScore turns MIDI or analyzed audio into synchronized physical animation. It is a TypeScript npm-workspace monorepo with Python/librosa/Demucs analysis, a deterministic browser Canvas 2D scene, and a legacy `@napi-rs/canvas` + ffmpeg video path.

## Current neural-to-race design

### Analysis

- `stems` mode runs Demucs `htdemucs_6s` and emits discrete onsets for the eight canonical roles: `kick`, `snare`, `percussion`, `bass`, `melodic`, `piano`, `guitar`, and `vocal`.
- Stem-presence gating removes near-silent separation bleed before either onsets or continuous signals are derived.
- `AudioAnalysis.roleSignals` is an optional version-1 continuous neural payload. The stems extractor emits it at 10 Hz with one fixed-order track per role:
  - `activityQ8`: activity quantized to integer `[0,255]`;
  - `sustainSpans`: sorted `[startFrame,endFrame)` regions;
  - pitched roles: `pitchDirection` (`-1|0|1`) and `pitchCoverageQ8`.
- The Node boundary strictly validates version, 10 Hz frame rate, frame count, canonical role order, array lengths, Q8 bounds, span ordering, and pitched-role-only fields.
- Raw analyzer events are stable-sorted and mapped one-to-one to `NoteEvent`s. The former TypeScript 90 ms thinning pass is gone. Exact co-timed events may share one physical contact later, but every source note ID remains represented.
- In stems mode, the compact UI `roleActivity` summary is built from waveform activity; onset-binned activity remains the fallback for analyzers without `roleSignals`.
- Web `auto` selects stems when the local Python probe finds Demucs with CUDA; otherwise it uses `smart`. CLI `auto` intentionally remains `smart` unless `--mode stems` is explicit.

### Deterministic 2D race planner

`packages/web/src/client/src/scene2d/model.ts` consumes the complete `AudioAnalysis` and builds semantically recognizable actors. The default grouping is three actors:

- `rhythm`: kick + snare + percussion;
- `bass`: bass;
- `lead`: melodic + piano + guitar + vocal.

This default is overridable: `settings.actorGroups` can define any grouping from one ball per role (up to eight) to a single ball fed by all roles. Only groups with enabled notes or signal activity exist. The planner preserves every enabled hit, merging only exactly co-timed notes within one group into one contact with multiple `noteIds`.

The music fixes where each actor must be at each timestamp; motion is then solved backward to justify those targets:

- horizontal progress is monotonic (`SCROLL_X = 6`) with a small actor-specific race bias;
- anchors descend through the world (`DRIFT_Y = 0.72`);
- unsupported intervals are exact constant-gravity ballistic segments (`GRAVITY = 18`, `BALL_R = 0.23`);
- neural sustain spans become supported cubic rails, with pitch direction influencing slope;
- rapid onsets become compact descending steps instead of deleting events;
- rests end the track and leave the actor in freefall;
- the strongest shared musical moment in each phrase drives deterministic convergence/crossover shaping;
- contact tangent/normal comes from sampled incoming/outgoing velocity, so hit lines physically explain the collision;
- static X bias plus deterministic separation adjustment prevents accidental ball overlap while retaining intentional visual crossings.

### Rendering and camera

- `scene2d/render.ts` draws near-white paper, black physical contacts/rails/supports, then solid actors. There are no lane baselines, labels, detached rings, waveform paths, particles, terrain, or screen shake.
- Impact squash and the seam are sampled at the actual ball/contact point; they cannot remain behind when a ball jumps.
- Contacts reveal near their event and fade behind (`0.10 s` preview, `0.58 s` trail). Sustained rails expose only `0.90 s` ahead and `0.48 s` behind, avoiding a viewport-wide visualizer thicket without dropping any event.
- The camera follows the actor pack and fit-zooms to a TRIMMED vertical band (percentile `[trim,1-trim]`, `trim=clamp(0.5/actorCount,0.03,0.12)`) so transient tall jumps / deep free-falls leave frame instead of zooming everyone out, while persistently offset balls stay framed. Hard backstops: spread cap `BALL_R*12+actorCount*3.2` and min scale `8`. Fixes the "one ball per sound zooms out so far you can't see anything" bug (verified: 8 balls + a ball leaving the pack keeps scale ~20–35, ball ≥4.5px, smooth). Seeking resets the camera so the next frame snaps.
- `Ctx2D` is deliberately limited to APIs shared by browser Canvas and `@napi-rs/canvas`. The race renderer is therefore export-compatible, but it is not yet wired into the legacy Node MP4 exporter.

### Web/runtime integration

- Audio analysis is returned through `/api/result/:jobId`; the original audio is the `<audio>` clock, so live frames are deterministic functions of `currentTime` and remain seek-safe.
- The Express server lazy-loads heavy CLI/native dependencies so it binds quickly.
- Audio jobs skip the old MP4 renderer and show the live race after analysis. MIDI and legacy explicit export still use the existing mapper/trajectory/node-canvas path.
- Actor grouping is user-configurable via `settings.actorGroups` (default rhythm/bass/lead). The controls let the user show/hide each ball, edit which stems feed each ball (add/remove/rename/recolor balls, one role per ball), and reset to default. There is no hidden actor-count or hit-count cap.
- Each ball also has manual `actorOverrides[id] = { yOffset, rotationDeg }`. Rotation is implemented as a vertical shear (`y += yOffset + tan(deg)*(x - pivotX)`, x untouched) so the time->x mapping, camera framing, and x-based culling stay valid; a true world rotation was rejected for coupling into x and risking non-monotonic x. Overrides run after planning/convergence, then `enforceRhythmHops` re-clamps so a downward tilt can never re-introduce a rhythm sag.
- Settings persist across "New Video". A persisted custom grouping that references only roles absent in a new song yields an empty scene; the overlay and the editor's "Reset to default" recover it.

## Real-song validation

Validated on `music/01 - Gary Moore - Still Got The Blues.mp3` with real CUDA stems analysis:

- mode: `stems`;
- duration: `250.96 s`;
- source hits: `5,900`;
- role-signal frames: `2,510`;
- role counts: guitar 816, bass 958, kick 1,172, snare 642, percussion 631, melodic 1,007, vocal 674.

Required windows were inspected from direct Canvas PNG renders:

- `00:00–03`: all `37/37` source hits represented;
- `00:18–22`: all `62/62` source hits represented.

Full-song sampled geometry checks:

- represented hits: `5,900/5,900`;
- maximum contact-center error: `2.842170943040401e-14`;
- maximum surface-radius error: `9.894862706971708e-14`;
- minimum actor distance: `0.6800000100096066`, above the required `0.46` separation.

### Independent visual + song-following audit (subagents)

Two read-only audits confirmed the renderer and the song-following behavior against real neural output:

- Rendering (synthetic mix): finite positions/velocities everywhere; contact-center and surface-radius errors ~1e-14; zero sagging rhythm ballistic segments; exact C0 segment joints; camera scale within `[5,220]` and smooth (max per-frame Δscale ~0.72); rails gated to `TRACK_BEHIND_SEC`/`TRACK_AHEAD_SEC` so none float detached; contacts fade via `temporalContactAlpha`; no detached rings/struts/zero-length lines.
- Song-following (real Gary Moore 0–40 s, Demucs `htdemucs_6s` on CUDA, 872 onsets across 7 roles, `roleSignals` present): `872/872` represented; "lands on the beat" max error ~1.5e-15; monotonic time→x; every slide rail lies inside a neural sustain span (bass 150/150, lead 320/320); rhythm makes zero slides. Windows `00:00–03` and `00:18–22`: all source hits represented and all actors actively moving.
- Robustness on non-Gary synthetic songs (sparse solo piano, dense electronic with drops, vocal-only): all finite, fully represented, correct sustain rails.
- Soft finding (by design, not a defect): rail slope follows `pitchDirection` ~70% of the time because `buildSegments` weights geometric slope between music-fixed anchors (0.68) above the pitch lean (0.32); pitch is a soft bias, not a strict contour map.
- Fixture note: the committed `.stems-seg-test.json` is a piano-only slice without `roleSignals`; anything using it falls back to the legacy section-cue support path.

## Validation commands

Run from the repository root in PowerShell:

```powershell
npx tsc -b
npx tsc -p packages/web/tsconfig.json
$env:PYTHON=".\.venv\Scripts\python.exe"; npx vitest run
npm run build -w @motionscore/web
.\.venv\Scripts\python.exe -m py_compile packages/note-extractor/python/extract_events.py packages/note-extractor/python/extract_stems.py
git diff --check
```

For a fresh Gary Moore evidence run, temporary scripts/snapshots can recreate the stems payload, PNGs, and exhaustive geometry checks, but `.tmp-snapshots/` is not a permanent project directory.

## Known limitations / next work

1. Wire `scene2d` into the Node exporter so a downloadable MP4 exactly matches the live race. The shared drawing interface already supports this; the integration is not done.
2. Heuristic `smart`/`beats`/`onsets` role names remain frequency-band estimates. Use `stems` for instrument identity.
3. Section cues are heuristic structural hints; the current race uses neural contacts/activity as primary truth and tolerates noisy cue overlap.
4. Tune physical/framing magnitudes only after viewing more songs. Do not reintroduce event thinning or count caps as a visual cleanup shortcut.

## Superseded designs

The following approaches were implemented during exploration and are no longer current:

- the React Three Fiber/Three.js ride, terrain, cat, parallax, and audio-reactive camera;
- one fixed lane/ball for every active role;
- continuous 190 ms impulse envelopes where balls moved around lane baselines;
- always-visible colored trajectory/waveform paths;
- detached impact rings, canvas labels, baseline flashes, and effects-only “juice”;
- section-cue slides that suppressed real onsets;
- TypeScript role-aware 90 ms hit thinning;
- full-viewport future rails/contact geometry.

Do not restore these to solve readability. The accepted model is target-first physical choreography: music fixes the contacts and supports, then gravity/rails explain how a small number of actors reach them.

## Key files

- `packages/note-extractor/python/extract_events.py` — lightweight analysis, features, cues.
- `packages/note-extractor/python/extract_stems.py` — Demucs separation, onsets, waveform `roleSignals`.
- `packages/note-extractor/src/audio-events.ts` — subprocess routing, strict payload validation, one-to-one event conversion.
- `packages/types/src/data-contracts.ts` — shared analysis contracts and role metadata.
- `packages/cli/src/pipeline.ts` — orchestration and analysis summary.
- `packages/web/src/client/src/scene2d/model.ts` — configurable actor grouping, deterministic physical planner, `applyActorOverride` (shear + offset).
- `packages/web/src/client/src/scene2d/render.ts` — physical geometry, actors, and centroid camera.
- `packages/web/src/client/src/scene2d/settings.ts` — `Scene2DSettings` (roleVisible, actorGroups, actorOverrides), defaults, merge/override helpers.
- `packages/web/src/client/src/scene2d/{types,index}.ts` — shared Canvas contract and public API.
- `packages/web/src/client/src/components/LiveScene.tsx` — audio-clocked Canvas loop.
- `packages/web/src/client/src/components/RideControls.tsx` — ball show/hide, per-actor y-offset/rotation sliders, grouping editor.
- `packages/renderer/src/stream-render.ts` — legacy baked MP4 renderer, not yet the race scene.
- `docs/AUDIO_ANALYSIS.md` — detailed Stage B reference.
- `docs/ARCHITECTURE.md` — current end-to-end architecture and invariants.
