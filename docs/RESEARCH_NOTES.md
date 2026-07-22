# Research Notes — Music-to-Physics Video Generator

Companion to `ARCHITECTURE.md`. This is a living document — the transcription
and physics-engine landscape move fast, so re-verify anything older than a
few months before committing to it. Confidence tags used throughout:

- **[VERIFIED]** — checked directly against a primary source (repo, docs,
  official page) during this research pass.
- **[REPORTED]** — claimed by one or more prior AI research passes, not
  independently re-checked here.
- **[CONTRADICTED]** — prior sources disagree; resolution/best-guess given.
- **[STALE RISK]** — true as of a given date but in a fast-moving space;
  re-check before relying on it.

This document synthesizes four independent AI research passes plus direct
verification of the highest-impact claims (licensing, release dates,
package existence). Treat it as the current best understanding, not final
truth — the open questions in §10 are specifically what the next research
pass should push on.

---

## 1. Audio/MIDI note extraction — tool shortlist

| Tool | Type | License / access | Confidence | Notes |
|---|---|---|---|---|
| **Spotify Basic Pitch** | pip/npm library | **Apache 2.0** [VERIFIED] | High | Lightweight, polyphonic, instrument-agnostic, pitch-bend detection. Still the default "quick, free, scriptable" pick as of mid-2026 per multiple independent comparisons. Good baseline / fallback regardless of what else is chosen. |
| **ByteDance piano transcription** (`bytedance/piano_transcription`, pip: `piano_transcription_inference`) | pip library (PyTorch) | Repo exists and is real [VERIFIED via GitHub/PyPI/arXiv]; **explicit license not confirmed in this pass** — check `LICENSE` file before depending on it commercially | Medium-high | Piano-specific, high resolution (onset/offset regression, F1 ~0.97 on MAESTRO per repo docs), detects pedal events. Best fit if input is confirmed solo/dominant piano. Community wrapper `azuwis/pianotrans` provides a GUI. |
| **MuScriptor** (Kyutai + Mirelo, `MuScriptor/muscriptor-{small,medium,large}` on Hugging Face) | Open-weight model, HF + GitHub inference code | **CC BY-NC 4.0 — NON-COMMERCIAL ONLY**, plus additional specific conditions of use [VERIFIED directly on HF repo page] | High confidence on the license flag specifically | Genuinely new (posted within the last few weeks of this writing), trained on 170k songs across genres, multi-instrument full-mix transcription without needing to know instruments in advance. **Do not wire in as a default pipeline dependency if there's any chance of commercial/monetized use without re-checking licensing terms.** Two of four prior AI passes recommended this as the top pick without surfacing the license — that omission is the single most important correction in this document. |
| **Klangio** | Commercial: apps, DAW plugin (VST3/AU), **and a real developer API** [VERIFIED — klang.io has a public API + plugin product line] | Paid, subscription-based (~$8.49+ for plugin; separate API/subscription tiers) | Medium | The only commercial transcription option confirmed to have genuine self-serve API access (as opposed to Songscription, below). Multi-instrument. Worth it if buying > building for the transcription stage specifically. |
| **Songscription.ai** | Commercial web app | Free tier (30-sec clips), paid tiers; **API access gated behind Enterprise/sales-contact tier, not self-serve** [REPORTED, consistent across two passes] | Medium | Strong for piano/real recordings per its own comparison content (inherently biased source — it's a competitor comparison written by Songscription itself, weight accordingly). |
| **NeuralNote** | Free VST/AU/standalone plugin | Free, open-source-adjacent | Medium | Wraps Basic Pitch's own model internally — **no accuracy gain over Basic Pitch**, purely a DAW-workflow convenience. Don't treat as a distinct/better option. |
| **A2M** (`Justagwas/A2M`) | Windows desktop app | Open source, custom model | Medium | ONNX Runtime with optional CUDA/DirectML GPU acceleration, piano-focused. Reported as very recently updated (within ~a day as of one research pass) — check current activity level before depending on it, desktop tools from small teams can go stale fast. |
| **MT3 / YourMT3+ / "MIROS"** | Research checkpoints | Research licenses vary | Low-medium (research-grade, not packaged) | Per a 2025 AMT Challenge, only two systems beat the MT3 baseline; the winner extended YourMT3+ by swapping in a self-supervised `MusicFM` encoder. These are benchmarks/checkpoints, not pip-installable products — relevant for understanding the accuracy frontier, not for direct integration without real engineering effort. |
| **Stem separation pre-pass (Demucs)** | Open source | Free | Medium | For full-mix (non-solo) input, separating stems before transcription is reported to produce cleaner note streams than direct full-mix transcription for models not specifically trained for multi-instrument input (MuScriptor claims to handle full mixes natively — worth A/B testing Demucs+BasicPitch vs. raw MuScriptor on a real song). |

**Recommendation for M1/M2 (see roadmap in `ARCHITECTURE.md`):** start with
Basic Pitch (permissive license, zero ambiguity, good enough for prototyping)
+ direct MIDI parsing for M1. Evaluate ByteDance piano transcription for a
quality upgrade on solo piano once the license is confirmed. Only consider
MuScriptor if the license is confirmed compatible with intended use, or if
this stays a personal/non-commercial project.

---

## 2. End-to-end / near-end-to-end open-source projects

**Confirmed across every research pass and re-checked here: no fully
open-source "song in → physics-choreographed video out" tool exists.** This
assumption in the original brief holds. The pipeline must be assembled from
per-stage pieces.

- **`AndrewB330/MusicMarbles`** [REPORTED, consistent across all passes] —
  the closest existing match. MIDI-driven marble+plank map generation,
  custom simplified C++/WASM physics engine, Tone.js for audio, recursive
  brute-force algorithm for map generation. MIT licensed. Modest traction
  (~29 stars/4 forks per one pass) and no sign of continued development —
  **treat as a reference/read for the algorithmic idea (particularly the
  recursive path-generation approach), not as a platform to fork and build
  on.** Its bespoke physics engine wasn't designed for the precise
  collision-timestamp control this project needs; building fresh on a real
  physics engine (§4) is the better path.
- **`jndean/LossRider`** [REPORTED] — a Python library that plots ML loss
  curves as Line Rider tracks. Useful only as a proof-of-concept that
  generating valid Line Rider track files programmatically from Python is
  straightforward — it contains no choreography/timing logic relevant to
  this project.
- The broader "AI music video generator" space (diffusion/GAN visuals synced
  to a beat) is a **different genre** — text-prompt-driven visual generation,
  not physics choreography. Not relevant prior art despite surface-level
  similarity in marketing language.

---

## 3. DoodleChaos (creator) — tooling status

[REPORTED, consistent across passes, treat as reasonably solid]

- No dedicated public repository for the marble/piano or Line Rider tooling.
  The only public repo under the creator's GitHub is `ChaosLeagueLiveOS`, an
  unrelated Twitch livestream game.
- Patreon posts (index/titles publicly visible even when content is
  paywalled) suggest a larger, Unity-centric toolchain than the Medium
  writeup covers:
  - For Line Rider pieces: reportedly mods a Line Rider Advanced build to
    dump rigging-point position data to JSON, then a separate script
    converts that path into 3D terrain by computing tangent/normal vectors
    along the motion path.
  - For domino/collision videos: pipeline reportedly runs in the *opposite*
    direction from what this project needs — Unity physics logs collision
    time/type, then Python synthesizes audio *from* that log ("physics
    generates audio," not "audio constrains physics"). **Flag: not all of
    this creator's known techniques transfer to our problem.**
  - Real project files are reportedly gated behind higher Patreon tiers,
    confirming source exists but isn't public.
- Bottom line: no forkable source. The Medium article on path-splicing
  remains the most detailed public technical description of this creator's
  approach to the *marble/piano* case specifically.

---

## 4. Physics engine shortlist

Priority signal for this project specifically: **continuous collision
detection (CCD) and precise sub-step collision timestamps matter more than
"determinism."** Determinism (identical output across machines/runs) mainly
matters for multiplayer/replay use cases — not directly relevant here. Screen
candidate engines on CCD support and timestep/collision-event precision, not
on determinism marketing claims.

| Engine | Type | Status | Confidence | Notes |
|---|---|---|---|---|
| **Jolt Physics** (`jrouwe/JoltPhysics`) | C++, 3D | Active, production-proven (Horizon Forbidden West, Death Stranding 2) [VERIFIED repo] | High | Has CCD. Web bindings confirmed real: `@react-three/jolt` / `pmndrs/react-three-jolt` and `sajal353/r3f-jolt` for React Three Fiber [VERIFIED via npm/GitHub], plus a native Three.js addon (`three/addons/physics/JoltPhysics`) [VERIFIED via threejs.org docs]. Strong pick for a JS/web 3D stack. |
| **Rapier** (Rust/WASM) | Rust core, WASM+JS bindings | Active | Medium-high | Reported as the most performant WASM option for web games, good CCD support. Not independently re-verified in this pass beyond prior reports — worth a direct check before committing. |
| **Box3D** (`erincatto/box3d`) | C17, 3D | **Real, newly released** — announced June 29-30, 2026 by Erin Catto (Box2D's creator) [VERIFIED: box2d.org announcement, GitHub repo with active commits, multiple tech press writeups] | High on existence/recency, **low on production-readiness** | Explicitly alpha, API still changing per the announcement itself. Fork of Box2D extended to 3D: sub-stepping solver, CCD, wide SIMD contact solving, large-world double-precision support. Forked from a Rubikon-Lite lineage (Valve's physics work). Genuinely promising for a lightweight C-native/WASM-feasible 3D engine, but too new to depend on for anything beyond experimentation right now — re-check maturity before committing. |
| **Box2D** | C, 2D | Mature, battle-tested | High | If staying strictly 2D (marble/piano tier likely can), Box2D remains a very safe, well-understood choice. Erin Catto continues to maintain it alongside Box3D. |
| **Pymunk** (Python binding of Chipmunk2D) | Python, 2D | Mature | Medium-high | Easiest option for a Python prototyping stack (M1/M2 in roadmap). Good enough for tier-2 ballistic verification; likely insufficient precision/control for tier-3 track optimization at scale — re-evaluate before relying on it for that stage specifically. |
| **Matter.js / Planck.js** | JS, 2D | Mature | Medium | Simpler alternatives to Rapier/Jolt for a pure-JS 2D prototype. Fine for early prototyping, likely to be outgrown once precise collision timing matters. |

**Recommendation:** prototype (M1) with Pymunk (Python) or Matter.js/Planck
(JS) for speed. For the aesthetic build (M3), move to Jolt (if JS/web,
especially if 3D is wanted) or Box2D (if staying 2D and want maximum
maturity/stability over Box3D's bleeding edge).

---

## 5. Line Rider ecosystem — corrections to the original brief

**This section contains the most important corrections versus the initial
research brief. Read carefully before making any Line Rider-related
architecture decision.**

- **"Song sync" in `linerider-advanced` is audio-playback alignment, not
  track generation.** [REPORTED, specific and detailed enough across the
  fourth response to trust] It lets a user pick an audio track and nudge a
  time offset so it plays in sync with a track *already hand-drawn* by a
  human. It does not generate track geometry from a song. This directly
  contradicts an earlier characterization of "song sync" as a
  generation feature — it is not.
- **The actual, confirmed workflow in the Line Rider community is to
  hand-build tracks to match music, or match music to a hand-built track —
  not automated in either direction.** The 30-frame remount timer (a core
  physics convention in the game) reportedly exists specifically because
  DoodleChaos needed it to sync one specific hand-built track. This
  reinforces that no generation tooling exists community-wide; even the
  genre's originator works by hand-tuning.
- **`jealouscloud/linerider-advanced` is not actively maintained.** [VERIFIED
  — GitHub releases page shows last tagged release **v1.04, dated
  2018-09-23** based on release notes content; AUR package listings show
  last updates in **2018-11**.] Calling it "actively maintained" is
  incorrect. **[STALE RISK — confirmed stale, not just "at risk."]**
- **Active development has moved to community forks**, specifically
  `RatherBeLunar/LRA-Community-Edition` (also mirrored at
  `Sussy-OS/LRA-Community-Edition`) [VERIFIED — repo exists, explicitly
  states its purpose is unifying features scattered across several LRA
  forks]. If a desktop/native Line Rider engine is wanted, target this fork,
  not the original.
- **A more promising integration target may be linerider.com itself**
  (the official web version), which reportedly has a documented Redux-based
  API/developer surface and a plain-JSON track format compatible with
  external tooling, deep enough that a full esoteric-programming-language
  interpreter has been built against it, runnable via the browser console.
  **[REPORTED, not independently verified in this pass — direct search for
  "linerider.com Redux API documentation" did not surface primary
  documentation, only tangential community userscript repos like
  `Malizma333/line-rider-command-editor-userscript`. Treat this claim as
  plausible but unconfirmed; the next research pass should verify this
  directly by inspecting linerider.com's actual client-side code/console API
  rather than searching for secondary descriptions of it.]**

**Net effect on the architecture:** Line Rider tier-3 choreography (§4 in
`ARCHITECTURE.md`) must be built from scratch regardless of which engine is
targeted — there is no shortcut here. The only open question is which
existing renderer/engine to target for *playback/export* once trajectories
are computed: `LRA-Community-Edition` (native, has bundled/auto-downloaded
ffmpeg export) vs. linerider.com (web, API surface unconfirmed — verify
before committing).

---

## 6. Rhythm-game prior art (osu!, Beat Saber) — what transfers and what doesn't

[REPORTED, richer than initially assumed, but with an important limitation]

- **osu!**: `osumapper` (TensorFlow, Colab-based beatmap generator),
  `Mapperatorinator` (more actively developed, generates/mods beatmaps
  directly from spectrogram input across game modes), commercial `Melokai`
  (transient analysis → flow-aware object placement with distance-snapping).
- **Beat Saber**: `InfernoSaber` (autoencoder + temporal convolutional
  network for beat detection + classifier networks for notes/lighting),
  `BeatMapSynthesizer` (trained on ~8,000 community maps above 70% rating,
  aligns librosa beat/spectral features with learned placement patterns).
- **The limitation that matters most for this project:** all of the above
  solve *when* (onset detection — same problem as Stage B) and *where* as a
  **stylistic, physics-free placement choice** — a hit object can appear
  anywhere on screen instantly, with no gravity, momentum, or continuous
  trajectory to satisfy. **None of this solves "what initial velocity gets a
  physical object to this exact point at this exact time,"** which is
  exactly the Stage D problem this project needs solved.
- **Where this prior art genuinely helps:** timing extraction techniques
  (reusable/adaptable for Stage B validation) and "natural-feeling"
  placement conventions/spacing heuristics (potentially useful for Stage C's
  musical mapping decisions — e.g. which notes are dense enough to skip).
  It is not a source of algorithms for Stage D. Closer prior art for Stage D
  is trajectory-optimization / boundary-value-problem literature from
  robotics and controls (see open question in §10).

---

## 7. Licensing summary (things to double-check before shipping anything)

| Component | License status | Action needed |
|---|---|---|
| Spotify Basic Pitch | Apache 2.0 [VERIFIED] | Safe for commercial use. |
| ByteDance piano transcription | Not confirmed in this pass | **Check `LICENSE` file in the repo before any commercial use.** |
| MuScriptor | **CC BY-NC 4.0 (non-commercial) + additional conditions** [VERIFIED] | **Do not use commercially without a separate license from Mirelo/Kyutai. Safe for personal/research/non-commercial use only, and even then check the "specific conditions of use" mentioned on the HF page in full.** |
| MusicMarbles | MIT [REPORTED] | Safe to reference/reuse code/ideas with attribution. |
| Klangio / Songscription | Commercial SaaS | Standard ToS/API terms apply if buying instead of building. |
| Box3D | Open source per Erin Catto's announcement [VERIFIED existence, license type not re-checked] | Confirm exact license file before depending on it (Box2D itself is historically zlib/MIT-style permissive; verify Box3D matches). |

---

## 8. Commercial landscape (2026 snapshot — reference only, "buy" side of build-vs-buy)

None of the following expose a self-serve API for automated pipeline
integration — they're all built for a human at a browser. This is the
strongest argument for "build" on the choreography/rendering stages, with
"buy" realistically only saving time on transcription (Klangio has a real
API; Songscription's is Enterprise-gated).

- **ViralBalls** — free, fully client-side (no account, no upload, renders
  in-browser to MP4). General "satisfying ring-bounce" genre (shatter,
  color-match), not melody-precise note-hitting. No API.
- **Ball Engine** (`ballengine.app`) — appears to be a rebrand of
  FunCircleGames. Subscription tiers reported (Free Starter, Pro Creator
  ~$29/mo, Studio Elite ~$159/mo). Markets "True MIDI Integration" and
  specific physics modes. No visible API. Positioned as a
  "faceless-YouTube-income" content tool, not a developer platform.
- **BallSimulator.com** — most directly comparable commercial analog to
  this project's actual goal: a note-placement grid where each bounce
  triggers a chosen melody, swappable instrument bank (up to nine, per one
  report). Subscription-only, no API. Worth studying for UX conventions.
- **Melodyne** — desktop plugin only, Essential tier ~$99 one-time. Not
  pipeline-automatable.

---

## 9. Contradictions found across the four prior AI responses (resolved)

- **MuScriptor's license**: three of four responses recommended it as a
  top-tier pick without mentioning licensing; the fourth flagged CC BY-NC
  4.0. **Resolution: the fourth response is correct** [VERIFIED directly
  against the Hugging Face model card]. This is the single biggest factual
  gap between the four responses.
- **`linerider-advanced` maintenance status**: earlier responses called it
  "actively maintained"; the fourth response corrected this to "last release
  2018, development moved to community forks." **Resolution: the correction
  is accurate** [VERIFIED via GitHub releases + AUR timestamps].
- **`linerider-advanced` "song sync" feature**: earlier responses implied or
  stated it could generate/help generate track geometry from a song; the
  fourth response clarified it's playback-offset alignment only, on a
  track a human already built. **Resolution: treat the fourth response's
  narrower description as correct** — not independently re-verified line by
  line in this pass, but it is specific enough (mentions exact UI behavior)
  to be credible over the vaguer earlier claims.
- **Whether a full open-source end-to-end tool already exists**: all four
  responses agree none does. **No contradiction — high confidence this is
  correct.**
- **Determinism vs. CCD as the right physics-engine selection criterion**:
  earlier responses emphasized determinism; the fourth response argued CCD
  and sub-step collision timing matter more for this specific use case.
  **Resolution: the fourth response's reasoning is sound and has been
  adopted in `ARCHITECTURE.md` §4** — determinism solves a cross-run
  consistency problem this project doesn't have; CCD solves the actual
  precision problem it does have.

---

## 10. Sharpened research prompts for the next pass

Prior broad prompts ("find better alternatives," "search more") have mostly
been exhausted for this project's needs. What's actually missing now is
narrower and deeper:

1. **Verify linerider.com's scripting/API surface directly** — inspect the
   site's own client-side code or find primary (not secondary/community)
   documentation for its Redux-based API, rather than relying on
   descriptions of userscripts built against it. Confirm whether track JSON
   can be constructed and loaded entirely programmatically (no browser UI
   interaction required) for a headless/automated pipeline.
2. **Confirm ByteDance piano transcription's actual license file contents**
   — not just that the repo exists.
3. **Re-check MuScriptor's licensing conditions in full** (the HF page
   mentions "additional specific conditions of use" beyond CC BY-NC 4.0 —
   read the complete terms, not just the license badge) in case there's a
   path to permitted use for this project's specific case (e.g. personal,
   non-monetized).
4. **Trajectory-optimization / boundary value problem literature search**:
   search robotics and controls literature (not rhythm-game or game-dev
   sources) for "minimum-time trajectory to waypoint sequence," "boundary
   value problem ballistic," or "shooting method spline trajectory
   optimization" — this is the actual academic neighborhood for Stage D
   tier 3, and hasn't been directly searched yet across any of the four
   prior passes.
5. **Re-verify Rapier's CCD support and current WASM performance
   benchmarks directly** (Jolt and Box3D were verified in this pass; Rapier
   was not).
6. **Check for movement since this writing**: Box3D is alpha and one week
   old as of this document — check for newer commits/releases, and check
   whether Jolt or Rapier have shipped comparable large-world/double-
   precision features in response.
7. **Look specifically for prototyping-grade example projects** combining
   any physics engine (Jolt/Rapier/Box2D/Pymunk) with a MIDI-driven timing
   target — i.e. someone's small demo/gist doing "object hits point at time
   T," even outside the marble/piano genre entirely (e.g. game-dev tutorials
   on "predictive aim" or "intercept trajectories," which solve a
   mathematically identical problem in a different context).
