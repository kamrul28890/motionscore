# Project Memory (quick resume)

Brief state + next steps so work can resume if context is lost. Keep terse.

## What this is
- MotionScore: music (MIDI/audio) -> physics video. TS monorepo (npm workspaces, `tsc -b`) + Python librosa analysis.
- Pipeline: extract (Stage B) -> mapNotes (C) -> planVoices -> solveChoreography (D) -> renderAndEncodeVoices + ffmpeg (E/F).

## Done
- Smart audio analyzer (Python): HPSS + low/mid/high onset fusion; roles (kick/bass/snare/percussion/melodic), salience, confidence; 10 Hz feature frames; section cues (build/drop/breakdown/rise/fall).
- Strict analyzer JSON validation + subprocess timeout + max-duration guard.
- `NoteEvent` gained `source`('midi'|'audio'), `role`, `confidence`, `salience`. `AudioAnalysis` + `AudioAnalysisSummary` contracts.
- Web: mode selector, analysis panel (roles histogram, energy sparkline, cue list), fixed progress-percent mapping.
- Multi-ball (Phases 1-2 DONE): contracts `VoicePlan`/`Voice`/`Choreography`/`VoiceGrouping`; `planVoices` (mapper); `solveChoreography` (solver); `renderAndEncodeVoices` (N tinted balls); `--balls single|per-role` (CLI) + web "Balls" selector (default single). Source-duration hold. ffmpeg stdin robustness (odd-dim = clean error, no listener leak).
- Cue detector reworked to whole-song relative (no arbitrary time/count caps) per user request.
- Neural stems mode DONE (`--mode stems`, opt-in): HitRole expanded to 8 (added vocal/piano/guitar) across types/validators/mapper lanes+colors/web panel/pipeline roleCounts; AudioAnalysisMode + ExtractionMode + CLI `--mode` + web selector gained `stems`. `extract_stems.py` = Demucs `htdemucs_6s` -> per-stem onsets (drums band-split kick/snare/percussion; bass/other->melodic/vocals/guitar/piano map direct); reuses extract_events.py for features/cues; CUDA with CPU fallback. audio-events.ts routes mode==='stems' to extract_stems.py. Thinning role-aware in buildNoteEvents; single-ball reachability thinning in planVoices.
  - KEY FIX: per-stem RMS energy gate (`STEM_PRESENCE_REL=0.12`, `STEM_PRESENCE_ABS=5e-4`) skips near-silent bleed stems, so an isolated instrument does NOT spawn phantom hits in every role. Without it a solo piano produced ~290 phantom "kick" hits.
  - VERIFIED on GPU (GTX 1060, cuda=True): solo piano -> `piano` only (82 raw, 76 after thinning, 1 piano ball, 0.00ms sync, video OK); Gary Moore blues -> active drums/bass/other/vocals/guitar, guitar=812 (piano correctly gated out). Full CLI pipeline green end-to-end.
  - Env: torch 2.4.1+cu121 + demucs 4.0.1 in `.venv` (coexist with librosa 0.11.0/numpy 2.4.6/scipy 1.18.0). `scripts/setup-demucs.ps1`+`.sh` (CUDA default, `-Cpu`/`--cpu`). Model ~170MB auto-downloads first run (cached).
  - Build/tests GREEN: `tsc -b`, vitest 110/110 (17 files), web build. Docs updated: AUDIO_ANALYSIS.md (stems section+tuning), MULTI_BALL_PLAN.md (Phase 3 stems DONE), README.md (mode+setup+examples).
  - OPEN (not blocking): stems raw density high (blues ~5831 events/251s across 7 roles ~3-4.6/s per role) — playable per-role; density tuning is a future refinement.
- Per-role activity viz DONE: shared role metadata is now single-source in `@motionscore/types` — `ROLE_ORDER`, `ROLE_COLORS`, `ROLE_LABELS`, `ROLE_ACTIVITY_BINS`(56). Mapper imports these (removed its local `ROLE_VOICE_COLOR`/`ROLE_ORDER`), so a ball's tint == its legend swatch. `AudioAnalysisSummary` gained `roleActivity: Record<HitRole, number[]>` (per role: 56 velocity-binned-by-onset values, normalized to that role's own peak). Built in `pipeline.summarizeAnalysis`. Web `AnalysisPanel` now renders "Instruments over time": per active role a color swatch + instrument name + SVG activity strip + count. Client mirrors palette in `packages/web/src/client/src/roleMeta.ts` (decoupled Vite bundle; keep identical to types). Verified: mode auto on download.mp3 -> kick 48/56 active bins peak 1.00, percussion 12/56, etc. `tsc -b`/vitest 110-110/web build GREEN.
- DECISION — ball show/hide + real-time controls (user asked): true real-time show/hide during playback belongs to the FUTURE interactive (three.js) renderer, because the current output is a baked MP4 (can't toggle balls after encode). Achievable NOW without the live renderer = a pre-render role include/exclude filter passed to `planVoices` (chicken-and-egg: roles known only after analysis, so best UX is analyze->show role chips->pick->render, or generic 8-role checkboxes). "Tuning bars" = a density/sensitivity slider mapping to `ROLE_DELTA`/`ROLE_MIN_GAP` (stems) or `maxNotesPerSecond` (mapper). Documented as next steps; not built yet.

## Known limitations
- Role labels in librosa modes (smart/beats/onsets) = frequency-band heuristic; mislabels acoustic/piano (onsets real, names wrong). FIXED for `--mode stems` (Demucs source separation -> real instrument roles). Heuristic still applies to the librosa modes only.
- Cue detection is heuristic energy/bass trends, not semantic structure.
- PNG `render()` fallback (render.ts) is single-ball only (tests); production streaming path is multi-ball.

## Verify / commands
- Build: `npx tsc -b`  | Web: `npm run web:build`  | Tests: set `PYTHON` then `npx vitest run` (currently 110 pass / 17 files).
- venv Python: `.venv/Scripts/python.exe` (set `$env:PYTHON`). Analyzer: `packages/note-extractor/python/extract_events.py <audio> <out.json> smart|beats|onsets`.
- User test files in `C:\Users\Basel Ashraf\Downloads` (mp3 + Birthday-1.mid). No need to full-render (slow); analyze directly.

## Next steps (in order)
1. Ball show/hide (pre-render role filter): after analysis, show role chips (reuse ROLE_COLORS/LABELS + roleActivity) and let user include/exclude roles; pass selected roles to `planVoices` (filter targets) via a new pipeline/CLI/web option. Achievable now; gives "how many balls" control without the live renderer.
2. Stems density tuning + a UI "sensitivity" slider: raw onset count is high. Map slider -> `ROLE_DELTA`/`ROLE_MIN_GAP` (stems) or `maxNotesPerSecond` (mapper). Validate ball counts stay musical per-role.
3. Phase 3 fidelity (librosa modes): voice-aware merging in analyzer (merge WITHIN a role, KEEP simultaneous cross-role hits); per-role lane/collision tuning.
4. 3D / interactive renderer ("Pulse Rail" / tap-game tower-bounce): Three.js/R3F, optional @remotion/three, on the `voices[]` model. Enables TRUE real-time ball show/hide + camera driven by section cues. Keep 2D path as fallback.
5. Further neural upgrades (opt-in, future, feed SAME NoteEvent/SectionCue contracts -> no downstream change): madmom neural drum/beat onsets; Essentia/MSAF structural segmentation for cues; consider Roformer / `python-audio-separator` or DrumSep/LarsNet for even cleaner stems.
   - DONE: Demucs `htdemucs_6s` stems -> real per-instrument voices (`--mode stems`), fixes role labels.

## Key files
- `packages/note-extractor/python/extract_events.py` — analysis + cues.
- `packages/note-extractor/src/audio-events.ts` — subprocess + validation + contract conversion.
- `packages/musical-mapper/src/index.ts` — mapNotes + planVoices.
- `packages/trajectory-solver/src/choreography.ts` — solveChoreography.
- `packages/renderer/src/stream-render.ts` — renderAndEncodeVoices (multi-ball).
- `packages/cli/src/pipeline.ts` — orchestration.
- `packages/types/src/{data-contracts,validators,config}.ts` — contracts + shared role metadata (`ROLE_ORDER`/`ROLE_COLORS`/`ROLE_LABELS`/`ROLE_ACTIVITY_BINS`).
- `packages/note-extractor/python/extract_stems.py` — Demucs stems analyzer (`--mode stems`).
- `packages/web/src/client/src/roleMeta.ts` — client mirror of role palette; `components/AnalysisPanel.tsx` — "Instruments over time" viz.
- Docs: `AUDIO_ANALYSIS.md`, `MULTI_BALL_PLAN.md`, `ARCHITECTURE.md`.
