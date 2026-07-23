# Music-to-Physics Video Generator — Architecture & Design

Working title: **MotionScore** (placeholder — rename freely).

## 1. Goal

Input a song (audio or MIDI). Output a video where a physical object (ball,
marble, Line Rider sled, etc.) moves under physics and strikes a target
(piano key, obstacle, note block) in exact sync with the song's notes/beats —
in the visual style of DoodleChaos-style marble/piano videos and Line Rider
music syncs.

**Non-negotiable quality bar:** the output must look good, not just be
technically synced. A physically "correct" trajectory that looks stiff,
robotic, or visually boring fails the brief. Aesthetics (camera, motion
shaping, particles, color, timing feel) are a first-class requirement, not
polish added at the end. See §6.

## 2. Guiding principle: build vs. use existing tools

Default to integrating mature open-source/library tools. Only build custom
when an existing tool would degrade output quality, lock us out of control we
need, or block future extensibility. Applied per-stage in §4 and summarized
in the decision log (§5).

## 3. Pipeline overview

```
 [Audio or MIDI file]
        │
        ▼
 STAGE A — Input Normalization
        │  (raw audio buffer, or parsed MIDI passthrough)
        ▼
 STAGE B — Note/Event Extraction        ["Transcription" module]
        │  → NoteEvent[]  (schema in §7.1)
        ▼
 STAGE C — Musical Mapping               ["Arrangement" module]
        │  → ChoreographyTarget[]  (schema in §7.2)
        ▼
 STAGE D — Choreography / Trajectory Solver   ["Trajectory" module — CORE IP]
        │  → Trajectory  (schema in §7.3)
        ▼
 STAGE E — Simulation & Rendering         ["Renderer" module]
        │  → raw video frames + audio track
        ▼
 STAGE F — Art Direction / Post           ["Aesthetics" module]
        │  → graded, styled frames
        ▼
 ffmpeg mux (frames + original audio)
        │
        ▼
 [Final video file]
```

Each stage is written as an independent module with a stable data contract on
either side. Any stage's underlying library can be replaced without touching
neighboring stages, as long as it still produces/consumes the same schema.
This is the mechanism that keeps the project extensible — treat each stage
below as a self-contained unit of work that could be built, tested, or
reassigned independently.

## 4. Module breakdown

### Stage B — Note/Event Extraction

**Purpose:** convert input into physically hittable musical events. MIDI retains exact
notes; mixed audio produces a role-labelled salient hit track plus continuous
features and structural section cues.

**Rules:**
- If input is already MIDI, parse it directly. Do not run it through an audio
  model. Direct parsing is exact.
- Mixed audio defaults to the smart analyzer, not full note transcription. It
  uses librosa HPSS plus independent low/mid/high onset envelopes to approximate
  percussive, bass, and harmonic stems. Candidate attacks are assigned roles,
  ranked by salience, merged when simultaneous, and suppressed when repetitive.
- Keep `beats` as a sparse metrical comparison mode and `onsets` as a denser
  full-mix comparison mode. Beat tracking alone omits fills and syncopation;
  raw onsets alone do not distinguish musical importance.
- Keep Basic Pitch as explicit `notes` mode for sparse solo/pitched recordings.
  It is intentionally not the mixed-song default because polyphonic notes and
  chords create too many targets for one physical object.
- True neural source separation (Demucs or a maintained equivalent) is an
  optional future high-quality mode. It must feed the same role/onset selector;
  every spike from every stem must never become a hit automatically.
- Discrete ball hits and longer scene controls are separate outputs. Loudness,
  bass energy, brightness, onset density, and harmonic/percussive energy are
  sampled at 10 Hz; builds, drops, breakdowns, rises, and falls are emitted as
  section cues with confidence. These do not create extra ball impacts.

**Build vs. use:** use mature librosa DSP primitives; build only the project-
specific salience, merging, trend detection, and physical-reachability policy.
Do not train a transcription or source-separation model from scratch.

**Output:** `NoteEvent[]` for the existing pipeline, or rich `AudioAnalysis`
(`hits`, `featureFrames`, `sectionCues`) for analysis UI/future renderers.

**Implementation reference:** the concrete algorithm, JSON schema, tuning
constants, limits, and web integration are documented in `AUDIO_ANALYSIS.md`.

### Stage C — Musical Mapping

**Purpose:** map retained events to lane/x-position/color and impact size, then
stabilize analyzer-generated target positions so short event gaps cannot demand
full-screen lateral jumps. MIDI pitch mapping remains exact; audio hit roles and
position hints are choreography controls rather than literal transcription.
Define the physical layout (piano key positions, lanes, obstacle map) here.

**Build vs. use:** build. This is bespoke creative/business logic specific to
the aesthetic being targeted, not a solved problem elsewhere. Keep it
pluggable — a "marble/piano" layout strategy and a "Line Rider lane" layout
strategy should both implement the same interface so Stage D never needs to
know which one is active.

**Output:** `ChoreographyTarget[]` — see §7.2.

### Stage D — Choreography / Trajectory Solver

**Purpose:** the actual hard problem. Given a start state and a sequence of
(position, time) targets, compute the physical motion — initial velocity, or
a full track spline — such that the object arrives at each target at the
exact required time, while looking physically plausible and visually
pleasing.

No off-the-shelf tool solves this end-to-end today (confirmed independently
across multiple research passes — see `RESEARCH_NOTES.md` §2). Rhythm-game
auto-mappers (osu!, Beat Saber) solve *when* and a stylistic *where*, but
their hit objects can appear anywhere on screen instantly — no gravity,
momentum, or continuous-motion constraint to satisfy. They are useful
reference for timing/placement conventions, not for the physics-arrival
problem itself.

Three tiers, in increasing order of difficulty and visual payoff. Build in
this order:

1. **Time-warping.** Simulate freely with a fixed layout, record natural
   collision timestamps, then non-linearly retime playback so each collision
   lands on the corresponding note onset. Cheapest to implement; likely what
   most consumer "satisfying ball" apps do. Good for a first end-to-end
   smoke test, not the final aesthetic target.
2. **Closed-form ballistic solve (recommended primary tier).** Between two
   hits, an object in freefall follows a parabola. Given a fixed start
   point, a target point, and a target duration (from the note timing),
   SUVAT kinematics let you solve directly for the exact initial velocity —
   pure algebra, no iteration. Chain arcs together and every hit lands
   exactly on time. This is the core of the marble/piano-key aesthetic and
   is genuinely tractable to build and get looking good.
3. **Track/spline optimization (shooting method).** Required for
   continuous-contact styles (Line Rider sled). The track shape itself
   determines arrival time, so there's no closed form — parameterize the
   track as a spline with adjustable control points, simulate, measure
   timing error at each waypoint, adjust control points, repeat until
   converged. Materially harder than tier 2. Do not start here.

**Aesthetics requirement specific to this stage:** a minimum-energy or
first-valid solution to the timing constraint will often look flat or
robotic. The solver should expose extra style parameters beyond the minimum
required to hit the timing (e.g. preferred arc height/apex, approach angle,
easing/anticipation before impact, variety across consecutive hits) so
Stage F / art direction has real degrees of freedom to work with, not a
single rigid answer. Treat "looks good" as a solver constraint, not a
post-process.

**Build vs. use:** build. This is the project's core differentiator. Reuse
math/literature where it helps (SUVAT for tier 2; shooting methods and
boundary-value/trajectory-optimization literature from robotics/controls for
tier 3 — see open question in `RESEARCH_NOTES.md` §6), but there is no
library to import here.

**Output:** `Trajectory` — see §7.3.

### Stage E — Simulation & Rendering

**Purpose:** simulate frame-by-frame for physical/visual verification and
render the final visuals — camera, geometry, lighting, particles, trails,
color.

**Physics engine:** needed mainly to refine/verify tier 3 (continuous
contact) and to give tier 2 believable collision response (bounce, spin,
particle triggers) rather than just moving a dot along a precomputed curve.
Prioritize **continuous collision detection (CCD)** support over raw
"determinism" claims — determinism mostly buys cross-machine/replay
consistency (multiplayer-style guarantees), not precision within a single
render. CCD is what actually gets you an accurate sub-step collision
timestamp, which is what this project needs. See `RESEARCH_NOTES.md` §4 for
the current engine shortlist and confidence levels on each.

**Build vs. use:** use an existing physics engine. Do not write a
general-purpose rigid-body engine from scratch. A minimal custom solver for
one specific case (e.g. ball-on-peg, as MusicMarbles' author did) remains an
acceptable fallback only if a general engine can't expose the precise
collision-timestamp control this project needs.

**Rendering/export:** use an existing rendering library (Three.js/React
Three Fiber or PixiJS/Canvas for a web stack; Pygame/Cairo/Manim for a
Python stack) and `ffmpeg` (native or `ffmpeg.wasm`) for final video export
and audio muxing. No reason to build either from scratch.

### Stage F — Art Direction / Post-processing

**Purpose:** the layer that turns "technically synced" into "looks good":
camera moves/follow, particle and impact effects, trails, color
grading/palette per pitch or section, background art, motion blur.

Keep this as a distinct, swappable layer on top of Stage E's raw simulation
output rather than baked into the physics or renderer code, so visual style
can change without touching simulation logic.

### Alternate track: Line Rider-specific integration

If the Line Rider aesthetic is pursued (after the marble/piano tier is
solid — see roadmap, §8):

- No tool auto-generates a synced track from a song today. Confirmed across
  every research pass. Stage D tier 3 must be built regardless of target
  engine.
- Prefer targeting **linerider.com's** own track JSON format / scripting
  surface over the desktop `linerider-advanced` fork, which is stale (see
  `RESEARCH_NOTES.md` §5 — last tagged release 2018). If a native/desktop
  renderer with built-in `ffmpeg` export is preferred instead, target the
  actively maintained **LRA-Community-Edition** fork rather than the
  original.
- `jndean/LossRider` is useful only as proof that programmatic track-file
  generation from Python is straightforward once coordinates are computed —
  it is not reusable choreography logic.
- DoodleChaos's own Line Rider tooling is confirmed closed-source
  (Patreon-gated Unity project files) — treat as inspiration only, not a
  fork target.

## 5. Decision log (build vs. buy, per stage)

| Stage | Decision | Rationale |
|---|---|---|
| B — Mixed-audio events | **Use librosa DSP + custom selection.** HPSS/multi-band onsets provide pseudo-stems; project code ranks, merges, labels, and suppresses hits. | Mature signal processing without a heavyweight model; selection is choreography-specific. |
| B — Full note transcription | **Use Basic Pitch only in explicit `notes` mode.** | Useful for sparse pitched recordings, too dense as the mixed-song default. |
| B — Neural stems | **Optional future adapter.** Evaluate a maintained Demucs-compatible tool before pinning a model. | Higher isolation quality, but large dependencies/model downloads and slower preprocessing. |
| C — Musical mapping | **Build.** | Bespoke creative logic, not a solved external problem. |
| D — Trajectory solver | **Build.** | Core IP. No existing tool solves timed-arrival physics choreography. |
| E — Physics simulation | **Use existing engine** (see `RESEARCH_NOTES.md` §4 for shortlist). Custom minimal solver only as fallback for one specific object/collision type. | Rigid-body physics is a solved, hard-to-outperform problem. |
| E — Rendering/export | **Use existing libraries** (Three.js/PixiJS/Manim + ffmpeg). | No reason to reinvent rendering or encoding. |
| Line Rider integration | **Target existing engine's format** (linerider.com or LRA-Community-Edition) rather than writing a Line Rider clone. | Preserves the exact aesthetic without rebuilding a full sled physics/rendering stack. |

## 6. Aesthetics — explicit requirements

Treat these as acceptance criteria, not nice-to-haves:

- Motion between hits should read as physically grounded (real gravity/arc
  feel), even where Stage D takes creative liberties with initial velocity
  to hit timing.
- Impacts need visual and audio weight (particle burst, squash/stretch,
  screen shake or camera reaction scaled to velocity/note velocity value).
- Color/lane mapping should be visually legible (e.g. circle-of-fifths or
  similar consistent, pleasant color mapping per pitch — reference: the
  marble/piano write-up in `RESEARCH_NOTES.md` §2 used this approach).
- Frame-accurate scheduling: if simulation runs on a fixed frame rate, verify
  note onsets are being hit within a perceptually acceptable tolerance (a
  handful of milliseconds), not just "close enough" — audio/visual sync
  errors above roughly 20-30ms become noticeable. Decide and document the
  tolerance budget once the render frame rate is fixed.
- Camera should not be static/orthographic by default if avoidable — framing
  and movement materially affect how "premium" the output feels compared to
  the flat commercial "satisfying ball" tools.

## 7. Data contracts

These schemas are the actual mechanism for extensibility: any stage's
implementation can be swapped as long as it still emits/consumes these
shapes. Version them (`schemaVersion`) so future format changes don't
silently break older generated content or cached intermediate files.

### 7.1 `NoteEvent[]` — output of Stage B

```json
{
  "schemaVersion": "1.0",
  "source": { "type": "audio|midi", "file": "song.wav", "durationSec": 182.4 },
  "notes": [
    {
      "id": "n0001",
      "pitchMidi": 60,
      "startSec": 1.203,
      "endSec": 1.560,
      "velocity": 0.82,
      "source": "audio",
      "role": "kick|bass|snare|percussion|melodic",
      "confidence": 0.91,
      "salience": 0.88,
      "track": "melody",
      "instrument": "piano"
    }
  ]
}
```

For mixed audio, `pitchMidi` is a stable horizontal-position hint derived from
the event role rather than a claim that a drum transient has a literal pitch.
`source`, `role`, `confidence`, and `salience` are optional so direct MIDI remains
backward-compatible. The mapper activates audio-only lane/slew hints only when
`source` is explicitly `audio`; a role-labelled MIDI event keeps exact pitch
placement.

### 7.1b `AudioAnalysis` — rich mixed-audio output

```json
{
  "version": 1,
  "durationSec": 182.4,
  "tempoBpm": 128.0,
  "mode": "smart",
  "hits": ["NoteEvent", "..."],
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
      "type": "build|drop|breakdown|rise|fall",
      "startSec": 40.0,
      "endSec": 44.2,
      "peakSec": 44.2,
      "intensity": 0.89,
      "confidence": 0.84
    }
  ]
}
```

`featureFrames` and `sectionCues` are intentionally not encoded as ball hits.
They are future renderer inputs for camera motion, vibration, long pre-drop
movement, lighting, particles, and environment deformation.

### 7.2 `ChoreographyTarget[]` — output of Stage C

```json
{
  "schemaVersion": "1.0",
  "layout": {
    "type": "piano-keys|lanes|track",
    "positions": { "60": { "x": 120, "y": 0 } }
  },
  "targets": [
    {
      "noteId": "n0001",
      "timeSec": 1.203,
      "position": { "x": 120, "y": 0 },
      "impactSize": 0.82,
      "colorHint": "#4477ff",
      "role": "kick"
    }
  ]
}
```

### 7.3 `Trajectory` — output of Stage D

```json
{
  "schemaVersion": "1.0",
  "objects": [
    {
      "objectId": "ball_01",
      "keyframes": [
        { "tSec": 0.0, "pos": [0, 0], "vel": [3.2, -1.1] },
        { "tSec": 1.203, "pos": [120, 0], "vel": [1.0, 4.5], "hitsTarget": "n0001" }
      ]
    }
  ]
}
```

Stage E consumes `Trajectory` plus the physics engine to simulate/verify and
render. It does not need to know how the trajectory was computed.

## 8. Roadmap

- **M0 — Scaffolding.** This document + `RESEARCH_NOTES.md`. Repo structure,
  schemas fixed as above.
- **M1 — Correctness prototype (MIDI in).** Parse MIDI directly →
  `NoteEvent[]` → naive Stage C (one lane per pitch range) → closed-form
  ballistic Stage D → minimal 2D renderer (plain shapes, no art direction).
  Goal: prove hits land exactly on time. No aesthetics yet.
- **M2 — Audio input.** Smart librosa HPSS/multi-band hit analysis is the
  default; beat, onset, and optional Basic Pitch note modes remain available.
  Continuous feature frames and structural cues are produced for future scene
  control. Validate and tune thresholds on a diverse real-song corpus.
- **M2.1 — High-quality stems (optional).** Benchmark a maintained neural stem
  separator against the lightweight default. Add it only when the hit-selection
  improvement justifies model downloads, runtime, and deployment complexity.
- **M3 — Aesthetic pass.** Swap in the chosen physics engine, add
  camera/particles/trails/color (Stage F), ffmpeg export with muxed audio.
  This is where the project starts looking like the reference videos.
- **M4 — Scale/expand tier.** Either: (a) scale the marble/piano tier —
  chords, multiple simultaneous objects, richer layouts; or (b) begin tier-3
  exploration for Line Rider-style continuous tracks. Treat as parallel
  optional tracks, not a required sequence.
- **M5 — Stretch.** Higher-accuracy/multi-instrument transcription swap-in,
  commercial transcription API integration if productizing.

## 9. Known risks

- **Aesthetic risk:** physically-correct ≠ good-looking. Mitigated by
  treating style parameters as first-class solver inputs (§4, §6), not a
  post-hoc pass.
- **Sync tolerance risk:** frame-rate quantization can make hits feel
  slightly off even when "technically" correct. Needs an explicit tolerance
  budget once frame rate is fixed.
- **Licensing risk:** at least one leading transcription model under
  consideration is non-commercial-only as of this writing. Do not lock in a
  transcription dependency without checking current license — see
  `RESEARCH_NOTES.md` §1 and §7.
- **Dependency staleness risk:** the obvious Line Rider desktop target is
  unmaintained since 2018. Don't build deep integration against it without
  confirming an actively maintained alternative is genuinely viable first.
- **Scope sequencing risk:** Line Rider tier 3 is a harder R&D problem than
  the marble/piano tier 2. Sequenced last in the roadmap for this reason —
  don't reorder without accepting the extra risk.

## 10. Extensibility principles (for future contributors)

- Never let Stage D or E know about "piano keys" or "marbles" specifically —
  they operate on the generic `ChoreographyTarget[]` / `Trajectory` schemas.
  Aesthetic-specific knowledge belongs in Stage C (what a target is) and
  Stage F (how it's dressed up visually), not in the physics/timing core.
- Any new input modality (e.g. sheet music/MusicXML) only needs a new Stage
  B adapter that emits `NoteEvent[]` — nothing downstream should need to
  change.
- Any new visual style (Line Rider, marbles, dominoes, whatever comes next)
  only needs a new Stage C layout strategy + Stage F art direction pass, as
  long as Stage D's solver tier supports the motion type (discrete-target
  ballistic vs. continuous-track).
- Keep `RESEARCH_NOTES.md` as a living document, not a one-time snapshot —
  the transcription and physics-engine landscape are moving quickly (see
  version dates throughout that file).
