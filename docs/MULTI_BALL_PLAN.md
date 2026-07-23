# Multi-Ball Plan (Multi-Voice Choreography)

Status: Phases 1 and 2 complete — multi-ball renders end to end via the
streaming path and is exposed as `--balls per-role` (CLI) / a "Balls" selector
(web), default `single`. Phase 3 is partially done: the neural `stems` mode
(Demucs `htdemucs_6s`) now feeds real per-instrument roles into `per-role`, so a
song can render a genuine guitar/piano/vocal/bass/drum ball each. This document
is the design of record for giving each musical "voice" its own ball. Remaining:
Phase 3 librosa voice-aware merging + collision/density tuning, and Phase 4 (3D).

## Motivation

Today one ball must hit every selected event in sequence. That single-ball
constraint is why the analyzer merges simultaneous cross-role events and
suppresses events it cannot physically reach. Giving each role/voice its own
ball removes that constraint: a kick ball and a snare ball can strike at the
same instant, and each ball carries far fewer, better-spaced targets — so we
can keep more of the music instead of thinning it. Multi-ball therefore
improves fidelity, not just visuals.

## Important scoping reality

Two analyzers feed the voice model. The `smart`/`beats`/`onsets` librosa
analyzer classifies hits into roles (kick, bass, snare, percussion, melodic)
from HPSS + frequency-band onsets — so with those modes the honest feature is
"a ball per role/voice group," e.g. drums vs bass vs melody. The `stems` mode
(Demucs `htdemucs_6s`, shipped) does real source separation, so it emits true
per-instrument roles (kick/snare/percussion/bass/piano/guitar/vocal/melodic) and
`per-role` gives an actual guitar ball, piano ball, vocal ball, etc. Both
analyzers emit the identical `NoteEvent` contract, so the voice model needed no
change to gain real instruments.

## Why this comes before the 3D renderer

Ball count is a data-model decision that three things are coupled to:

1. The solver currently emits one `ObjectTrajectory`. Multi-ball means one
   trajectory per voice.
2. The analyzer merge/suppression policy exists because of the single ball.
   With per-voice balls, merging should be within a role, not across roles.
3. The planned 3D concept (camera, path, lanes) assumes a ball count. Building
   the camera/path around one ball and retrofitting N later is expensive.

Locking a multi-voice contract now means the 3D work consumes `voices[]`
natively and multi-ball ships as configuration rather than a rewrite.

## Data model

New contracts in `@motionscore/types` (additive; nothing existing changes
shape):

```ts
type VoiceGrouping = 'single' | 'per-role';

interface Voice {
  id: string;                 // 'voice_all' | 'voice_kick' | ...
  label: string;              // display/role label
  role?: HitRole;             // present for per-role voices
  colorHint: string;          // ball tint (per-voice visual identity)
  startPosition: [number, number];
  targets: ChoreographyTarget[];
  trajectory: ObjectTrajectory;
}

interface Choreography {
  durationSec: number;
  voices: Voice[];
}
```

Single-ball is simply `voices.length === 1` — the one voice contains every
target, matching today's behavior exactly. This is the backward-compatibility
guarantee.

## Grouping rules

- `single` (default initially): one voice, all targets, one ball. Identical to
  current output.
- `per-role`: one voice per `HitRole` that actually appears in the targets. With
  `smart` this is up to five roles; with `stems` it is up to eight real
  instruments (only the roles actually present survive the stem energy gate, so
  a solo piano yields a single piano ball). MIDI (which has no roles) and
  `notes` mode fall back to `single`.
- Future `custom`: named groupings (e.g. all-drums = one ball, melodic = one
  ball) via config; no contract change required.

Each voice gets:
- a stable `colorHint` (role-based palette) so balls are visually distinct;
- a `startPosition` spread horizontally (role lane x at the top of the canvas)
  so balls do not all launch from the same point;
- its own target subsequence (targets partitioned by role).

## Solver

`solveChoreography(voices, config)` solves each voice independently by reusing
the existing `solveTrajectory` on that voice's targets, with the voice's own
`startPosition`. Per-voice solving is simpler than the combined solve (fewer,
more spaced targets → fewer unreachable skips) and is trivially parallelizable.
The `±15ms` sync guarantee is unchanged per ball.

## Renderer (Phase 2)

Generalize `render()` and `renderAndEncode()` to accept multiple
`{ trajectory, targets, ballColor }` render voices:
- total frame count = max last-keyframe time across voices;
- draw N balls, N trails (one trail buffer per voice), and aggregate impacts
  from all voices;
- keep the single-ball functions as thin wrappers so existing tests/callers do
  not change.

## Analyzer merge policy (Phase 3, optional refinement)

Make the Python merge/suppression voice-aware: merge and suppress within a role
but keep simultaneous cross-role hits. This is where multi-ball's fidelity gain
is fully realized (kick + snare landing together). Phase 1/2 already work on the
already-merged targets, so this is a later enhancement, not a blocker.

## Config / CLI / Web

- `CLIOptions.balls?: 'single' | 'per-role'` (default `single`).
- CLI: `--balls <mode>`.
- Web: a "Balls" selector in `ConfigForm`, validated in the server.
- Pipeline threads the grouping into `planVoices`.

Default stays `single` so existing behavior and tests are unaffected until the
user opts in.

## Phased plan

- Phase 1 — DONE (foundation, no behavior change):
  - 1a: `Voice` / `VoicePlan` / `Choreography` / `VoiceGrouping` contracts +
    `validateChoreography` + exports.
  - 1b: `planVoices(targets, grouping, layout)` in musical-mapper; default
    `single` reproduces current output; unit tests.
  - 1c: `solveChoreography(voices, config)` in trajectory-solver; per-voice
    start positions; unit tests.
- Phase 2 — DONE (visible multi-ball in the current 2D renderer):
  - `renderAndEncodeVoices` draws N tinted balls/trails and all impacts;
    `renderAndEncode` is now a single-ball wrapper over it.
  - Pipeline wires `planVoices -> solveChoreography -> extend-to-duration ->
    validateChoreography -> renderAndEncodeVoices`.
  - `balls` option added to `CLIOptions`, `--balls`, and the web form (default
    `single`). Verified end to end (`--balls per-role` on a real track produced
    5 tinted balls, one per detected role, 0.00 ms sync error).
  - Note: the PNG `render()` fallback in `render.ts` is only used by tests and
    remains single-ball; the production streaming path is multi-ball.
- Phase 3 — PARTIALLY DONE (fidelity):
  - DONE: neural `stems` mode (Demucs `htdemucs_6s`) delivers real per-instrument
    roles, so `per-role` gets true instrument balls (see the roadmap below).
    Thinning is role-aware (merge within a role, keep simultaneous cross-role
    hits).
  - TODO: voice-aware merging in the *librosa* analyzer; per-role start-lane and
    collision tuning; density tuning for stems mode (its raw onset count is high
    before thinning).
- Phase 4 — TODO (3D): the `voices[]` model feeds the future Three.js scene
  planner. Multi-ball is native there rather than retrofitted.

## Neural upgrade roadmap (optional, post multi-ball)

The current role labels come from HPSS + fixed frequency bands, so they are only
meaningful for percussive/electronic material — e.g. a solo piano is mislabeled
as kick/bass/snare (the onsets are real; the names are not). The multi-voice
model is designed to consume better sources without any contract change:

- Stems — DONE (`--mode stems`). Demucs `htdemucs_6s` splits a mix into six
  stems: `drums`, `bass`, `other`, `vocals`, `guitar`, `piano`. Per-stem onset
  detection runs on each; the isolated `drums` stem is band-split into
  kick/snare/percussion, and `bass`/`other`/`vocals`/`guitar`/`piano` become
  their own roles. A per-stem RMS energy gate drops near-silent bleed stems so an
  isolated instrument does not spawn phantom hits. This replaces the
  frequency-band heuristic with real separation and directly fixes the
  mislabeling. It is heavy (PyTorch + ~170 MB model, GPU recommended; a 6 GB
  VRAM card is enough), so it is an opt-in mode, not the librosa default. Set it
  up with `scripts/setup-demucs.*`. Implemented in
  `packages/note-extractor/python/extract_stems.py`.
- Onsets — madmom's neural drum/beat detectors are stronger than volume-based
  onset picking for rhythm-game-style timing; a candidate for per-stem onsets.
- Structure — Essentia (pretrained segmentation) or MSAF for build/drop/section
  boundaries, replacing the current heuristic cue detector for higher accuracy.

Integration point: each of these feeds the SAME `NoteEvent` (with `role`,
`source`) and `SectionCue` contracts, so they slot in as an alternate Stage B
analyzer selected by mode/flag. No downstream (mapper/solver/renderer) change.

## How the "tower / staircase bounce" aesthetic fits

The tap-game staircase-tower idea (a ball bouncing down descending steps) maps
cleanly onto this model and is a strong candidate for the first 3D style:

- Each voice = one ball descending its own tower/staircase lane.
- Each hit = one step the ball lands on; step position comes from the target,
  the exact arrival time still comes from the solver, so it stays in sync.
- Section cues reshape the tower: builds tighten/steepen the steps, a drop is a
  long fall onto an oversized landing, breakdowns widen and calm the descent.
- Multiple towers side by side (one per voice) reads clearly and is satisfying,
  which is exactly why this is worth building on the multi-voice foundation
  rather than a single-ball hack.

This remains a Phase 4 rendering concern; Phases 1-3 make it cheap to build.

## Backward-compatibility checklist

- `extract()` and `NoteEvent[]` unchanged.
- `solveTrajectory()` and `render()`/`renderAndEncode()` single-ball signatures
  remain valid (multi-ball added alongside).
- Default `balls: 'single'` → byte-for-byte current behavior.
- New contracts are additive and optional.
