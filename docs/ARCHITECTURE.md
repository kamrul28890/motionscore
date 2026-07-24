# MotionScore Architecture

Last updated: 2026-07-23.

## 1. Goal

MotionScore turns audio or MIDI into synchronized physical animation. The current web experience targets the recognizable DoodleChaos mechanic: a small cast of actors moves through sparse black physical geometry, and the music determines where each actor **must be** at each event time. Gravity, catches, and sustained rails are solved backward to explain how it arrived there.

The quality bar is both mechanical and perceptual:

- every enabled musical event remains represented;
- contact occurs at the event timestamp and at the actor surface;
- motion reads as gravity/support rather than a waveform or generic impulse;
- an actor's timing and motion make its musical role recognizable without relying on labels;
- geometry is revealed as terrain, not displayed as a full future event chart;
- the camera follows the race without audio shake or decorative clutter.

## 2. Current runtime paths

There are two related paths during the migration to the new scene:

### Live audio race (current web path)

```text
Audio
  -> Stage B analyzer (librosa or Demucs)
  -> AudioAnalysis { hits, featureFrames, sectionCues, roleSignals? }
  -> server /api/result + /api/audio
  -> scene2d buildScene2D()
       semantic grouping -> target placement -> ballistic/rail solve
  -> renderScene2D(browser Canvas, audio.currentTime)
```

For audio uploads, the pipeline uses `skipRender`; the browser renders directly from the complete analysis while the original audio element supplies the clock.

### Legacy MIDI / baked-video path

```text
MIDI or extracted NoteEvent[]
  -> mapNotes / planVoices
  -> solveChoreography
  -> @napi-rs/canvas stream renderer
  -> ffmpeg mux
```

This path remains operational, but it does not yet use the neural race scene. The `scene2d` renderer depends on a deliberately small `Ctx2D` interface shared by browser Canvas and `@napi-rs/canvas`, so it is ready for exporter integration without a visual rewrite.

## 3. Design principles

1. **Analysis and choreography have separate semantics.** Discrete hits say when an impact must happen. Continuous role activity says when physical support may exist. Full-mix features and section cues describe longer musical structure; they do not manufacture impacts.
2. **Targets precede trajectories.** The planner chooses music-fixed contacts first, then solves the path between them. It never animates a generic envelope and hopes it appears synchronized.
3. **No silent event loss.** Enabled neural events are mapped one-to-one. Dense passages change geometry (steps and shorter contacts), not event count.
4. **A few semantic actors beat many lanes.** Source roles are grouped into rhythm, bass, and lead, preserving note identity while avoiding an eight-lane visualizer.
5. **Geometry must be physical.** A black line is a collision surface or a sustained support. Unsupported time is freefall; no decorative path is drawn through it.
6. **Determinism is the synchronization mechanism.** Planning and sampling are pure functions of analysis/settings/time. Playback, seeking, screenshots, and future exports therefore agree.
7. **Effects do not substitute for causality.** Detached rings, labels, particles, terrain, shake, and always-visible traces were rejected because they obscured rather than explained the music-motion relationship.

## 4. Stage B — event and signal extraction

### 4.1 MIDI

MIDI is parsed directly. Exact note timing, pitch, duration, velocity, track, and instrument are retained; no audio analyzer is involved.

### 4.2 Lightweight audio modes

`smart`, `beats`, and `onsets` use librosa. The smart analyzer combines HPSS, low/mid/high onset envelopes, salience, confidence, and whole-song-relative structural analysis. `notes` uses Basic Pitch for sparse pitched recordings.

These modes emit:

- `hits`: audio `NoteEvent`s;
- 10 Hz full-mix `featureFrames`;
- structural `sectionCues` (`build`, `drop`, `breakdown`, `rise`, `fall`).

Their role names are frequency-band heuristics, so they are useful for lightweight analysis but not guaranteed instrument identity.

### 4.3 Neural stems mode (implemented)

`stems` runs Demucs `htdemucs_6s` on CUDA when available, with CPU fallback. It separates drums, bass, other, vocals, guitar, and piano. Drum bands produce kick/snare/percussion; the other stems map directly to bass/melodic/vocal/guitar/piano.

A relative + absolute RMS presence gate removes near-silent separation bleed. Accepted stems produce two independent products:

1. exact discrete onset events;
2. `roleSignals`, a compact continuous per-role waveform description.

The stems analyzer emits one fixed-order role track at 10 Hz for each canonical role:

```ts
type PitchDirection = -1 | 0 | 1;
type SustainSpan = [startFrame: number, endFrame: number];

interface RoleSignalTrack {
  role: HitRole;
  activityQ8: number[];          // integers 0..255
  sustainSpans: SustainSpan[];   // sorted, non-overlapping
  pitchDirection?: PitchDirection[];
  pitchCoverageQ8?: number;      // integer 0..255
}

interface RoleSignals {
  version: 1;
  frameRateHz: 10;
  frameCount: number;
  tracks: RoleSignalTrack[];
}
```

Pitch fields are valid only for bass, melodic, piano, guitar, and vocal. Empty/absent stems still have an all-zero canonical track, keeping the wire shape deterministic.

### 4.4 Trust boundary and event preservation

`packages/note-extractor/src/audio-events.ts` treats analyzer JSON as untrusted. It validates finite ranges, mode, event arrays, feature frames, cues, and every role-signal invariant: version, exact 10 Hz rate, frame-count agreement, canonical role order, exact array lengths, Q8 bounds, sorted valid spans, direction values, and pitched-only fields.

After validation, `buildNoteEvents()` stable-sorts raw events and maps every valid event to one `NoteEvent`. There is no downstream 90 ms TypeScript thinning and no per-second count cap. Analyzer-level perceptual peak selection still determines what constitutes an onset, but downstream code does not silently discard accepted neural events.

Detailed extraction behavior lives in `AUDIO_ANALYSIS.md`.

## 5. Stages C/D — semantic race choreography

The live scene combines arrangement and trajectory solving in `packages/web/src/client/src/scene2d/model.ts`. The legacy mapper/solver packages remain for the baked-video path.

### 5.1 Actor selection

The default grouping is **one ball per sound** (`DEFAULT_ROLE_ACTORS` in `model.ts`): each present role becomes its own actor, named by the sound (Kick, Snare, …) and tinted with that role's distinct colour. The physics family (`kind`) per role is:

| kind | Source roles | Motion character |
|---|---|---|
| rhythm | kick, snare, percussion | staccato bounces and rapid steps |
| bass | bass | heavy catches and sustained rails |
| lead | melodic, piano, guitar, vocal | pitched rails, arcs, phrase crossings |

An actor exists only if it has enabled hits or sustained activity. Exact co-timed notes within one ball share a contact that stores every source `noteId`.

This is only the default. `buildScene2D` uses `settings.actorGroups` when the user supplies a custom grouping (see §5.7), so the scene can range from one ball per sound (up to eight) to a single ball fed by every sound. When a custom group mixes families, its `kind` is `lead` if it contains any pitched role, else `bass` if it contains bass, else `rhythm`. The older semantic rhythm/bass/lead triple (`ACTOR_GROUPS`) is retained as a named preset but is no longer the default.

### 5.2 Music-fixed targets

For each actor, contacts and support boundaries become anchors. Time maps monotonically to world X (`SCROLL_X = 6`) plus a small actor race bias. World Y descends over time (`DRIFT_Y = 0.72`) and is shaped by event spacing, support activity, rapid passages, and phrase choreography.

The planner first places all anchors, then applies deterministic phrase-level convergence/crossover adjustments. The strongest shared contact cluster in each phrase is the musical reason for actors to approach or exchange ordering; there is no random weaving.

### 5.3 Ballistic segments

Unsupported intervals use exact constant-gravity motion with `g = (0, GRAVITY)`, `GRAVITY = 18`. For endpoints `p0`, `p1` separated by `dt`, the required launch velocity is solved directly:

```text
v0 = (p1 - p0 - 0.5*g*dt^2) / dt
p(t) = p0 + v0*t + 0.5*g*t^2
```

This guarantees endpoint timing without iterative simulation. A rest/silence ends support and leaves the actor on this freefall path.

**Bounded silence, by actor family.** A single full-gravity ballistic arc across a multi-second silence is degenerate: `0.5*g*dt^2` grows without bound, flying up and plunging thousands of units. The two families handle a rest differently, and both are bounded:

- **Rhythm (bouncing):** `createAnchors` subdivides an unsupported gap longer than `max(beatSec*2, 0.95) s` into short sub-hops on the rest line. The cap is derived from a target apex (`apex = g·dt²/8`), so a drum silence reads as a settling bounce and no hop is tall/near-vertical (this fixed the "percussion teleports up" defect — apex fell from ~7 to ~2). `depth` is zeroed for rhythm and hops are re-clamped upward-only by `enforceRhythmHops`.
- **Pitched (lead/bass):** a gap is kept as **one** freefall arc — the dramatic fly-up-and-return the design wants — but its per-segment gravity is reduced to `min(GRAVITY, 8·APEX_MAX_PITCHED/dt²)` (`APEX_MAX_PITCHED = 10`) so the arc still hits the next onset exactly on time while its peak stays bounded. Pitched gaps are NOT subdivided: subdividing turned a freefall into a string of bounces on invisible ground, which read as "bouncing on nothing." `depth` still eases to a bounded rest offset.

**Active-range clipping.** Each `Actor` carries `activeStartSec`/`activeEndSec` (first→last contact or support boundary). `createAnchors` seeds the timeline at that range, not `0..durationSec`, and the renderer skips an actor (camera and all draw passes) outside it. So a sound that enters late — e.g. a vocal that starts at 0:21 — simply is not present during the intro instead of bouncing on empty paper for 20 s. `hasSignalActivity` also requires activity ≥ 0.3, so a role that is only separation bleed spawns no ball at all.

### 5.3b Dynamics: sustained swell and pitch height

Motion amplitude used to depend only on timing/gaps, so a held loud/high note (e.g. a sustained vocal "so long") produced no reaction. Two planner terms now translate real dynamics into motion, using data the analyzer already provides:

- **Pitch height → vertical position.** For pitched actors, `musicalOffset -= (pitchMidi - pitchCenter) * 0.1` (raised from 0.055), so a higher note sits visibly higher.
- **Sustained-activity surge.** After the baseline/rail Y is set, a pitched actor is lifted **undamped** by `SUSTAIN_SWELL_LIFT * (activity - 0.35)` (`SUSTAIN_SWELL_LIFT = 4.5`) whenever the neural role `activity` exceeds `0.35`. A held, high-activity passage surges the ball up sharply and lets it recede as the energy fades. Verified: a synthetic loud/high held note surges ~8 world units (~35 ball radii) versus normal singing.

Because `activityQ8` is per-role normalized, this distinguishes held/high-energy passages from quiet ones, but not "loud" from "even louder"; capturing absolute dynamics would need an added `loudnessQ8` channel in the extractor (future work).

### 5.4 Sustained rails

Neural `sustainSpans` create supported slide segments. The rail is a cubic curve through its anchors; shared anchor slopes give adjacent pieces C1 continuity. Pitched-role direction biases the rail slope, making register movement visible without drawing pitch labels. Support struts are reserved for genuine catches or structurally heavy support, not stamped under every short onset.

### 5.5 Contacts and dense passages

Rapid events become compact descending steps. Contact-line length derives from nearby event spacing, so dense music creates appropriately short surfaces rather than deleting contacts or producing a black wall.

After segments are built, the planner samples incoming/outgoing velocities at each contact. Their physical tangent/normal sets the line orientation and the ball-surface point. Slide contacts take precedence over rapid/high-fall classification, and high-fall catches apply only to incoming ballistic motion.

### 5.6 Separation

Actor-specific X bias and deterministic anchor adjustments preserve a minimum center distance while still allowing paths to cross visually. This is validated over the sampled full song rather than assumed from fixed lanes.

### 5.7 User configuration (grouping and manual overrides)

`Scene2DSettings` carries three song-independent, serializable knobs consumed by `buildScene2D`:

- `roleVisible: Record<HitRole, boolean>` — per-sound show/hide before grouping.
- `actorGroups?: ActorGroupConfig[]` — optional custom grouping. Each entry is `{ id, kind, label, color, roles }` and becomes one ball. When present it fully replaces the default; when absent the default is one ball per sound (`DEFAULT_ROLE_ACTORS`). A role appears in at most one ball.
- `actorOverrides?: Record<actorId, { yOffset, rotationDeg }>` — manual spatial adjustment per ball, keyed by group `id`.

`RideControls` presents each ball as a drag-and-drop box: sounds are draggable chips, dropping a chip into another ball groups them, dropping it on the "New ball" zone splits it out, and empty balls are removed automatically. Each ball has an editable name (defaulting to the sound, never a number), a colour picker, a show/hide toggle, and height/tilt sliders. Regrouping recomputes each ball's `kind` from its contents.

Overrides are applied by `applyActorOverride` after automatic planning and convergence, then rhythm hops are re-clamped. Two deliberate correctness choices:

1. **Rotation is a vertical shear, not a world rotation.** `y += yOffset + tan(rotationDeg) * (x - pivotX)`, with `x` left untouched. The whole pipeline assumes `x == timeSec * SCROLL_X + bias` and monotonic (camera framing and x-based visibility culling depend on it). A true rotation would couple into `x`, could reverse it on tall paths, and would desynchronize time from horizontal position. For the near-horizontal race paths a shear looks like a tilt while keeping every downstream invariant intact. The pivot is the actor's first anchor, so a positive angle tilts the later end downward.
2. **The bounce invariant outranks the override.** `enforceRhythmHops` runs *after* the override, so a strong downward tilt on a rhythm ball is re-clamped and can never re-introduce a sagging arc. A rhythm ball therefore resists extreme downward tilt by design; pitched/bass balls tilt freely.

Custom settings persist across "New Video". If a persisted custom grouping references only roles absent from a newly loaded song, every ball filters out and the scene is empty; the controls expose "Reset to default" to recover.

## 6. Stage E/F — Canvas rendering and art direction

`packages/web/src/client/src/scene2d/render.ts` renders a sparse physical world:

1. near-white paper background;
2. visible portions of black sustained rails and supports;
3. black physical impact/catch lines (a `catch` is a concave-up cradle — its rims rise toward the ball along `-normal` and the curve dips to a rounded valley at the contact, so the ball visibly drops INTO it; earlier it was drawn rims-down and read as an upside-down arch);
4. solid actor circles, drawn last.

There are no fixed lanes, canvas labels, detached rings, waveform/trajectory traces, terrain, particles, or screen shake. Impact squash and the seam are transformed from the sampled actor/contact itself, so they remain attached during collision.

### Temporal geometry

Geometry is time-revealed so it reads as upcoming terrain rather than a full event visualization:

- contact preview: `0.10 s`;
- contact trail: `0.58 s`;
- rail look-behind: `0.48 s`;
- rail look-ahead: `0.90 s`.

Every contact still appears at its own time. Temporal reveal changes visibility, not representation.

### Camera

The camera follows the actor pack and fit-zooms to where most balls are, moving through the right-and-down world without audio-energy shake. Only actors that are currently active (within their `activeStartSec..activeEndSec`) are included in the framing, so an idle instrument neither drags the camera toward an empty region nor forces a zoom-out; if nothing is active it holds position using all actors. The camera state resets on seek so random-access playback and snapshot rendering remain deterministic.

Fit zoom uses a **trimmed** vertical extent, not the raw min/max envelope. Positions are time-sampled over the look-ahead window across all actors; the vertical band is the `[trim, 1-trim]` percentile of those samples, with `trim = clamp(0.5 / actorCount, 0.03, 0.12)`. Because each ball contributes a `1/actorCount` share of samples and `trim < 1/actorCount`, a ball that is *persistently* offset (its whole window sits high/low) is kept in frame, while a ball that *briefly* jumps very high or free-falls during a rest occupies only a few samples and is trimmed — it may leave frame instead of forcing everyone to shrink. This directly fixes the "one ball per sound zooms everything out" problem. A per-actor-count spread cap (`BALL_R*12 + actorCount*3.2`) and a raised minimum scale (`8`) are hard backstops so the view can never collapse to an unreadable size regardless of ball count. Verified with 8 balls and a ball jumping out of the pack: scale stayed ~20–35 px/unit (ball radius ≥4.5 px) with smooth per-frame change (~0.08).

### Shared renderer boundary

The scene renderer uses `Ctx2D`, the intersection of browser Canvas 2D and `@napi-rs/canvas`. It has no React or DOM dependency. `LiveScene.tsx` owns only canvas sizing, the `requestAnimationFrame` loop, and audio time. This separation is what allows the same model/render functions to be moved into the Node exporter later.

## 7. Data contracts

### 7.1 `NoteEvent`

```ts
interface NoteEvent {
  id: string;
  pitchMidi: number;
  startSec: number;
  endSec: number;
  velocity: number;
  source?: 'midi' | 'audio';
  role?: HitRole;
  confidence?: number;
  salience?: number;
  track?: string;
  instrument?: string;
}
```

For heuristic/stems audio, `pitchMidi` is a choreography/register hint, not a claim that a transient has a literal MIDI pitch.

### 7.2 `AudioAnalysis`

```ts
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

`roleSignals` is additive and optional, preserving compatibility with MIDI and non-stems analyzers.

### 7.3 Scene settings

```ts
interface ActorGroupConfig { id: string; kind: ActorKind; label: string; color: string; roles: HitRole[]; }
interface ActorOverride { yOffset: number; rotationDeg: number; }

interface Scene2DSettings {
  roleVisible: Record<HitRole, boolean>;
  actorGroups?: ActorGroupConfig[];
  actorOverrides?: Record<string, ActorOverride>;
}
```

All fields are optional-additive and serializable; `mergeSceneSettings` fills defaults. See §5.7 for semantics.

### 7.4 Scene model

The live planner produces a `Scene2DModel` containing actors, contacts, ballistic/slide segments, physical constants, bounds, and source/represented hit counts. Sampling functions are part of the contract:

- `sampleActor(actor, timeSec)`;
- `sampleActorVelocity(actor, timeSec)`;
- `sampleRaceSegment(segment, timeSec)`;
- `sampleRaceVelocity(segment, timeSec)`.

Render code samples this solved model; it does not reconstruct musical motion independently.

## 8. Correctness invariants

The current implementation is expected to preserve these invariants:

1. `representedHitCount === sourceHitCount` for enabled roles.
2. X progress remains positive through the race.
3. Every segment samples exactly to its two anchors.
4. At each contact, actor center-to-surface distance equals `BALL_R` within floating-point tolerance.
5. Physical line tangent/normal derives from local segment velocity.
6. Sustained support exists only where neural role activity supports it.
7. Unsupported time is ballistic freefall and has no drawn path.
8. Actors do not violate the required center separation except where a future design explicitly models a collision, or where the user has manually overridden positions.
9. Live sampling is deterministic under playback and seeking.
10. `x == timeSec * SCROLL_X + bias` and monotonic for every actor, including under manual overrides (rotation is a vertical shear, never a world rotation).
11. The rhythm bounce invariant (no sagging ballistic arc) holds after manual overrides, because hops are re-clamped last.
12. Every ballistic arc's apex is bounded: rhythm by gap subdivision (`apex ≈ g·dt²/8`, `dt ≤ max(beatSec*2,0.95)`), pitched by reduced per-segment gravity (`apex ≤ APEX_MAX_PITCHED`). No arc escapes to infinity during silence.
13. An actor is only sampled/drawn within `activeStartSec..activeEndSec`; it never bounces on empty paper before it enters or after it ends.

## 9. Validation evidence

The real neural path was run on `music/01 - Gary Moore - Still Got The Blues.mp3`:

- `mode=stems`, duration `250.96 s`;
- `5,900` source hits and `2,510` 10 Hz signal frames;
- `5,900/5,900` hits represented in the full scene;
- max contact-center error `2.842170943040401e-14`;
- max surface-radius error `9.894862706971708e-14`;
- minimum actor distance `0.6800000100096066` for a required `0.46`.

Direct Canvas snapshots covered both user-reported failure windows:

- `00:00–03`: `37/37` events represented;
- `00:18–22`: `62/62` events represented.

The visual pass led to bounded rail look-ahead/trail, event-timed contact reveal, shorter dense-event lines, smoothed sustained anchors, and C1 slide joints.

Configurable grouping and manual overrides were verified separately with synthetic analyses covering: 0 hits, 1 hit, one role per ball (eight actors), all eight roles merged into one ball, an empty group beside a real one, and custom groups combined with overrides. Under a strong downward tilt the override checks confirmed `x` is byte-identical to the un-tilted scene, remains monotonic, no rhythm ballistic segment sags, and `representedHitCount == sourceHitCount`.

The per-sound default, late-entry clipping, and bounded-arc changes were verified headlessly: default produces eight sound-named distinct-colour balls; a vocal that enters at 20.9 s has `activeStartSec = 20.9` and no contacts before it; rhythm hop apex fell to ~1.5 (from ~7); a long pitched gap stays one arc with reduced gravity (~0.5) bounded to <9 units; representation stays exact; and a full 0–40 s render sweep kept the camera finite with scale ~45–110 and ball radius ≥10 px even while an actor was idle.

## 10. Decisions and status

| Concern | Current decision | Status |
|---|---|---|
| Lightweight analysis | librosa HPSS/multi-band modes | Implemented |
| Neural instrument identity | Demucs `htdemucs_6s` + presence gate | Implemented |
| Continuous role data | optional 10 Hz Q8 `roleSignals` | Implemented |
| Event preservation | one-to-one after analyzer acceptance | Implemented |
| Live arrangement/solver | target-first 1–3 actor race | Implemented |
| Unsupported motion | exact constant-gravity ballistic solve | Implemented |
| Sustains | neural-activity cubic rails | Implemented |
| Rendering | deterministic sparse Canvas 2D | Implemented in web |
| Camera | active-pack centroid + look-ahead + trimmed fit zoom | Implemented |
| Actor grouping | user-configurable, default one ball per sound | Implemented |
| Grouping UI | drag-and-drop ball boxes (name/colour/show-hide) | Implemented |
| Silence bounding | rhythm subdivision + pitched reduced-gravity arc + active-range clip | Implemented |
| Catch geometry | concave-up cradle bowl | Implemented |
| Per-stem audio muting | serve Demucs stems + client Web Audio mix | Proposed (see §13) |
| Export parity | reuse `scene2d` from Node exporter | Pending integration |

## 11. Superseded architecture

The following are historical and must not be treated as current requirements:

- neural stems as a future-only option;
- capped “busiest roles” in fixed lanes;
- 190 ms impulse motion and always-visible colored paths;
- section-cue glides that replace real onset reactions;
- detached impact rings, in-canvas role labels, mandatory particles/shake;
- the removed R3F/Three.js ride and terrain scene.

The accepted aesthetic is sparse physical causality, not visualizer ornamentation.

## 12. Key files

- `packages/types/src/data-contracts.ts` — canonical contracts and role order.
- `packages/note-extractor/python/extract_events.py` — lightweight analyzer/features/cues.
- `packages/note-extractor/python/extract_stems.py` — Demucs events + role signals.
- `packages/note-extractor/src/audio-events.ts` — validation and conversion.
- `packages/cli/src/pipeline.ts` — orchestration and summaries.
- `packages/web/src/client/src/scene2d/model.ts` — race planning and sampling.
- `packages/web/src/client/src/scene2d/render.ts` — geometry, actors, camera.
- `packages/web/src/client/src/scene2d/types.ts` — renderer/model types and `Ctx2D`.
- `packages/web/src/client/src/scene2d/settings.ts` — `Scene2DSettings`, actor groups, overrides.
- `packages/web/src/client/src/components/LiveScene.tsx` — browser loop/audio clock.
- `packages/web/src/client/src/components/RideControls.tsx` — grouping editor + per-actor sliders.
- `packages/renderer/src/stream-render.ts` — legacy Node video renderer.
- `docs/AUDIO_ANALYSIS.md` — detailed analyzer reference.

## 13. Proposed: per-stem audio enable/disable (feasibility)

Goal: when a ball is hidden, actually mute that instrument in playback (not just the visual).

Grounded assessment of the current pipeline:

- `extract_stems.py` already separates the mix into the six `htdemucs_6s` stems (`drums, bass, other, vocals, guitar, piano`) in memory, then discards the audio — only the analysis JSON is written.
- The server serves the single ORIGINAL mix at `GET /api/audio/:jobId`; `LiveScene` plays it through one `<audio>` element that is both the master clock and the transport (native play/pause/seek).

Hard limitation to design around: `kick`, `snare`, and `percussion` are band-splits of the ONE `drums` stem, so at the audio level they cannot be muted independently — mutable granularity is per stem: **Drums (all percussion together), Bass, Melody (`other`), Vocals, Guitar, Piano.** Ball visibility stays per sound; audio mute maps ball→stem and mutes drums only when all of kick/snare/percussion are hidden. True per-drum muting would need a dedicated drum-separation model (LarsNet/DrumSep) — out of scope.

Concrete plan (phased):

1. Python: `extract_stems.py` optionally writes each accepted stem to a job dir as a compressed mono file (Opus/MP3, mono to bound size) and returns their paths. Verifiable via `py_compile` + a real run.
2. Wrapper/pipeline/server: surface stem paths through `extractWithAnalysis` → `PipelineResult` → job; add `GET /api/stem/:jobId/:name` (range-capable) and include the stem list in `/api/result`; extend cleanup.
3. Client: a Web Audio engine decodes the stems into buffers and schedules them on ONE `AudioContext` clock (sample-accurate by construction — not the drift-prone multi-`<audio>` approach), one `GainNode` per stem; ball visibility sets stem gains. This replaces the `<audio>` transport with a context-based one (custom play/pause/seek), and the visualizer clock reads `AudioContext.currentTime`.

Cost/risk: storage/bandwidth (six stem files per job), added export time, and a transport rework. Web Audio single-clock scheduling makes A/V sync robust, but final audio quality/sync can only be confirmed by listening (not headless-verifiable), so this is gated on explicit go-ahead rather than shipped blind.
