# MotionScore

A music-to-physics video generator. Feed it MIDI or a mixed audio song and it produces an H.264 MP4 where a ball moves under gravity, striking musically salient targets in sync. Audio defaults to smart harmonic/percussive and frequency-band attack analysis; full Basic Pitch transcription remains optional for sparse solo recordings. Available as both a CLI tool and a web application.

## Quick Start

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# --- Option A: CLI ---
npx motionscore song.mid -o output.mp4

# --- Option B: Web UI ---
npm run web:build
npm run web:start
# Open http://localhost:3001
```

## Web Interface

A browser-based UI that exposes all the same features as the CLI — upload a file, configure settings, watch real-time progress, then preview and download the video.

```bash
# Development mode (hot-reload)
npm run web:dev

# Production mode
npm run web:build    # Build React frontend + Express server
npm run web:start    # Start on http://localhost:3001
```

To enable audio input on the web server, set `PYTHON` before starting:

```powershell
# Windows (PowerShell)
$env:PYTHON = "$PWD\.venv\Scripts\python.exe"
npm run web:start
```

```bash
# macOS / Linux
PYTHON=.venv/bin/python npm run web:start
```

### Features

- **Drag-and-drop file upload** — accepts .mid, .midi, .wav, .mp3, .flac, .ogg
- **Full configuration** — FPS, resolution, layout strategy, with quick presets (1080p/720p/4K)
- **Real-time progress** — animated progress bar, current stage, scrolling log, elapsed timer (via Server-Sent Events)
- **Video preview** — in-browser HTML5 player with standard controls
- **Download** — one-click download of the generated MP4
- **Stats display** — total notes, rendered frames, duration, max sync error

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/generate` | Upload file + config (multipart form), returns `{ jobId }` |
| GET | `/api/progress/:jobId` | SSE stream of pipeline progress events |
| GET | `/api/video/:jobId` | Serve the generated MP4 (inline) |
| GET | `/api/video/:jobId/download` | Serve with attachment header for download |

The server cleans up temporary files (uploads + outputs) after 30 minutes.

## Requirements

- **Node.js** >= 22.12 (tested on Node 26)
- **ffmpeg** on PATH ([download](https://ffmpeg.org/download.html)) — required for video export
- **Python 3 + librosa** — needed for the default smart/beats/onsets audio modes
- **Basic Pitch** (optional) — needed only for `--mode notes` full transcription
- **PyTorch + Demucs** (optional) — needed only for `--mode stems` neural per-instrument separation (GPU recommended; a 6 GB VRAM card is enough)

Smart/beats/onsets analysis currently accepts up to 12 minutes per file to bound decoded-audio and HPSS memory. Split longer mixes before processing.

> For a full reference on the audio analysis subsystem (smart stem-aware modes,
> JSON schema, roles/salience, feature frames, section cues, and web
> integration) see [`docs/AUDIO_ANALYSIS.md`](docs/AUDIO_ANALYSIS.md). The
> multi-ball roadmap is in [`docs/MULTI_BALL_PLAN.md`](docs/MULTI_BALL_PLAN.md).

### Setting up Python audio analysis

The setup script creates a project virtual environment and installs librosa plus the optional Basic Pitch transcription stack:

```powershell
# Windows (PowerShell)
.\scripts\setup-audio.ps1
```

```bash
# macOS / Linux
./scripts/setup-audio.sh
```

This creates a `.venv/` in the project root with librosa and its dependencies. After setup, point the `PYTHON` environment variable at the venv's Python executable so the analyzer subprocess uses it:

```powershell
# Windows — set before running
$env:PYTHON = "C:\path\to\visualizer\.venv\Scripts\python.exe"
```

```bash
# macOS / Linux
export PYTHON="$(pwd)/.venv/bin/python"
```

Or add a `.env` file at the project root:

```
PYTHON=.venv/Scripts/python.exe
```

**Optional full note transcription:** `--mode notes` additionally requires Basic Pitch. Run `scripts/setup-basic-pitch.ps1` (Windows) or `scripts/setup-basic-pitch.sh` (macOS/Linux); it reuses the same `.venv`.

**Optional neural per-instrument separation:** `--mode stems` additionally requires PyTorch + Demucs. Run `scripts/setup-demucs.ps1` (Windows) or `scripts/setup-demucs.sh` (macOS/Linux); it reuses the same `.venv` and installs a CUDA build by default (pass `-Cpu` / `--cpu` for a CPU-only build). The ~170 MB `htdemucs_6s` model downloads automatically on first use. Stems mode separates the mix into real instruments (drums, bass, guitar, piano, vocals, other), so `--balls per-role` gives a genuine guitar/piano/vocal/bass/drum ball each instead of frequency-band guesses.

**Manual equivalent for the lightweight analyzer:**

```bash
python -m venv .venv
.venv/Scripts/python -m pip install --upgrade pip
.venv/Scripts/python -m pip install "librosa==0.11.0"
```

The Basic Pitch setup script installs its pinned package plus ONNX/transcription dependencies.

## CLI Usage

```
Usage: motionscore [options] <input>

Generate a physics-synced video from a MIDI or audio file.

Arguments:
  input                   path to the input file (MIDI: .mid/.midi, audio: .wav/.mp3/.flac/.ogg)

Options:
  -o, --output <path>     path to the output video file (required)
  --fps <number>          target frame rate (default: 60)
  --width <number>        video width in pixels (default: 1920)
  --height <number>       video height in pixels (default: 1080)
  --layout <type>         target layout strategy (choices: "piano-keys", "lanes", default: "piano-keys")
  --mode <mode>           audio hit selection: "auto", "beats", "onsets", "notes", or "stems" (default: "auto")
  --balls <mode>          how many balls: "single" or "per-role" (one ball per instrument) (default: "single")
  --verbose               print progress information for each pipeline stage
  -h, --help              display help for command
```

### Examples

```bash
# Basic MIDI to video
npx motionscore song.mid -o video.mp4

# Lower resolution for faster rendering
npx motionscore song.mid -o video.mp4 --width 640 --height 360 --fps 30

# Mixed song: smart stem-aware attacks (default/recommended)
npx motionscore song.wav -o video.mp4

# Comparison modes
npx motionscore song.wav -o beats.mp4 --mode beats     # sparse metrical pulse
npx motionscore song.wav -o onsets.mp4 --mode onsets   # all full-mix attacks
npx motionscore solo.wav -o notes.mp4 --mode notes     # Basic Pitch transcription
npx motionscore song.mp3 -o stems.mp4 --mode stems     # neural per-instrument (Demucs)

# One ball per detected instrument role. With --mode stems these are real
# instruments (guitar, piano, vocal, bass, drums); otherwise frequency-band
# roles (kick, bass, snare, percussion, melodic).
npx motionscore song.mp3 -o multiball.mp4 --mode stems --balls per-role

# Verbose output showing per-stage timing
npx motionscore song.mid -o video.mp4 --verbose
```

### Output

On success the CLI prints a summary:

```
Done. Wrote output.mp4
  Total notes:     6
  Rendered frames: 169
  Duration:        3.00s
  Max sync error:  0.00ms
```

The max sync error is the worst-case timing difference between any ball impact and its target note onset. The solver guarantees this stays within 15ms (typically 0.00ms since it uses exact closed-form math).

## Project Structure

This is a TypeScript monorepo using npm workspaces and `tsc -b` (project references). Each package is independently buildable and testable.

```
packages/
  types/              Shared data contracts, config interfaces, error classes, validators
  note-extractor/     Stage B: MIDI parsing, smart librosa analysis, optional Basic Pitch
  musical-mapper/     Stage C: pitch-to-position, color, density filtering
  trajectory-solver/  Stage D: SUVAT ballistic arc solver (core IP)
  renderer/           Stage E: headless PNG frame rendering (@napi-rs/canvas)
  video-export/       Stage F: ffmpeg H.264 muxing (fluent-ffmpeg)
  cli/                CLI entry point wiring all stages together
  web/                Web UI: Express API server + React frontend (Vite)
scripts/
  setup-audio.ps1         Lightweight librosa setup for Windows
  setup-audio.sh          Lightweight librosa setup for macOS/Linux
  setup-basic-pitch.ps1   Optional Basic Pitch notes-mode setup for Windows
  setup-basic-pitch.sh    Optional Basic Pitch notes-mode setup for macOS/Linux
```

## Pipeline Overview

```
Input (.mid or .wav/.mp3/.flac/.ogg)
  |
  v
Stage B: Note / Hit Extraction
  - MIDI: parse exact notes directly (@tonejs/midi)
  - Audio auto: HPSS + bass/mid/high onset fusion; merge and rank salient hits
  - Audio beats/onsets: comparison modes using librosa
  - Audio notes: optional Basic Pitch transcription
  -> NoteEvent[] (timing, strength, role, confidence, stable position hint)
  -> AudioAnalysis when requested (10 Hz features + build/drop/section cues)
  |
  v
Stage C: Musical Mapping
  - MIDI pitch -> x-position; analyzer roles -> stable lanes/position hints
  - Slew-limit analyzer-generated targets to prevent impossible lateral jumps
  - Pitch -> color (circle-of-fifths palette)
  - Velocity -> impact size
  - Optional density filtering (notes-per-second cap)
  -> ChoreographyTarget[] (position, time, color, impact, role)
  |
  v
Stage D: Trajectory Solver (Core IP)
  - SUVAT kinematics: solve for exact initial velocity between each target pair
  - Chain ballistic arcs so ball arrives at every target on time
  - Sample keyframes at configured FPS
  -> ObjectTrajectory (dense keyframe sequence with impact markers)
  |
  v
Stage E: Frame Rendering
  - Interpolate ball position on FPS grid
  - Draw targets as colored piano-key rectangles
  - Fading trail behind ball
  - Expanding-circle particle bursts on impact
  - Write numbered PNGs to temp directory
  -> frame_00001.png, frame_00002.png, ...
  |
  v
Stage F: Video Export
  - ffmpeg: encode PNG sequence to H.264
  - Mux original audio (for audio input) or video-only (for MIDI)
  -> output.mp4
```

## Development

### Scripts

```bash
npm run build        # Build all packages (tsc -b)
npm run typecheck    # Same as build (type-checks via project references)
npm run clean        # Remove all dist/ output
npm test             # Run all tests (vitest)
npm run test:watch   # Run tests in watch mode
npm start -- <args>  # Run the CLI (equivalent to npx motionscore <args>)

# Web interface
npm run web:dev      # Dev mode with hot-reload (frontend + backend)
npm run web:build    # Build React frontend + Express server for production
npm run web:start    # Start production server on port 3001
```

### Running Tests

```bash
# Full suite (currently 98 tests across 16 files)
npm test

# Single package
npx vitest run --project types
npx vitest run --project note-extractor
npx vitest run --project musical-mapper
npx vitest run --project trajectory-solver
npx vitest run --project renderer
npx vitest run --project cli
```

### Adding a New Package

1. Create `packages/<name>/` with `package.json` (scoped `@motionscore/<name>`, `"type": "module"`)
2. Add `tsconfig.json` extending `../../tsconfig.base.json` with `rootDir: src`, `outDir: dist`
3. Add `"exclude": ["src/**/*.test.ts"]` so tests don't leak into dist
4. Add the package to root `package.json` workspaces array
5. Add a project reference in root `tsconfig.json`
6. If it imports other packages, add them to both `dependencies` and `tsconfig.json references`

### TypeScript Conventions

- **Strict mode**: `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `verbatimModuleSyntax`
- **ESM only**: `"type": "module"`, `module: "nodenext"`, `moduleResolution: "nodenext"`
- **Explicit .js extensions** in all relative imports (required by nodenext)
- **No `any`**: implicit any is blocked by strict; avoid explicit any
- **Project references**: `tsc -b` builds the dependency graph automatically

### Testing Conventions

- Framework: **Vitest 4** with per-package projects
- Property-based tests: **fast-check** (all correctness properties from the design are covered)
- Test files live alongside source as `src/**/*.test.ts`
- Tests import from `./module.js` (resolves to `.ts` under Vitest) to avoid stale-dist issues
- Integration tests at the repo root: `test/**/*.test.ts`

## Data Contracts

Each stage communicates through typed interfaces defined in `@motionscore/types`. Validators run at every stage boundary so errors surface early with precise diagnostics.

### NoteEvent (Stage B output)

```typescript
interface NoteEvent {
  id: string;              // Unique, zero-padded: 'n0001', 'n0002', ...
  pitchMidi: number;       // MIDI pitch, or stable x-position hint for audio hits
  startSec: number;        // >= 0
  endSec: number;          // > startSec
  velocity: number;        // [0.0, 1.0] impact strength
  source?: 'midi' | 'audio'; // Explicit provenance for choreography behavior
  role?: 'kick' | 'bass' | 'snare' | 'percussion' | 'melodic';
  confidence?: number;     // [0.0, 1.0]
  salience?: number;       // [0.0, 1.0] musical importance
  track?: string;
  instrument?: string;
}
```

For audio callers that need more than ball hits, `analyzeAudioEvents()` returns:

```typescript
interface AudioAnalysis {
  version: 1;
  durationSec: number;
  tempoBpm: number;
  mode: 'smart' | 'beats' | 'onsets';
  hits: NoteEvent[];
  featureFrames: AudioFeatureFrame[]; // 10 Hz loudness/bass/brightness/etc.
  sectionCues: SectionCue[];          // build/drop/breakdown/rise/fall
}
```

### ChoreographyTarget (Stage C output)

```typescript
interface ChoreographyTarget {
  noteId: string;          // References NoteEvent.id
  timeSec: number;         // Impact time (= note.startSec)
  position: { x: number; y: number };  // World coordinates
  impactSize: number;      // [0.0, 1.0], from velocity
  colorHint: string;       // Hex color from pitch
  role?: 'kick' | 'bass' | 'snare' | 'percussion' | 'melodic';
}
```

### ObjectTrajectory (Stage D output)

```typescript
interface ObjectTrajectory {
  objectId: string;        // 'ball_01'
  keyframes: TrajectoryKeyframe[];
}

interface TrajectoryKeyframe {
  tSec: number;            // Strictly ascending
  pos: [number, number];   // [x, y]
  vel: [number, number];   // [vx, vy]
  hitsTarget?: string;     // Set on impact keyframes
}
```

## Configuration Interfaces

All configuration is typed. See `packages/types/src/config.ts` for the full definitions:

- **CLIOptions** - parsed command-line arguments
- **LayoutConfig** - musical mapper (canvas size, target row, pitch range, density filtering)
- **SolverConfig** - trajectory solver (gravity, start position, fps, sync tolerance)
- **RenderConfig** - renderer (fps, dimensions, ball radius, trail/particle toggles, output dir)
- **ExportConfig** - video export (frame dir, pattern, audio path, output path, codec, quality)

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| librosa HPSS + multi-band onsets for audio `auto` | Uses mature open-source separation/onset primitives already in the venv. It captures fills and instrument attacks that beat tracking omits without the density of note transcription. Neural stem separation remains an optional future quality mode because of model size and processing cost. |
| Basic Pitch only for `--mode notes` | Full transcription is useful for sparse pitched recordings but too dense to drive one ball on most mixed songs. |
| `@napi-rs/canvas` over `@pixi/node` | PixiJS node adapter requires native `gl`/`canvas` peer deps that fail to build without an OpenGL toolchain. @napi-rs/canvas ships prebuilt N-API binaries. |
| `fluent-ffmpeg` for video export | Wraps ffmpeg subprocess cleanly; shell-free argument passing (no injection risk). |
| `@tonejs/midi` for MIDI parsing | Handles tempo maps, multi-track, and velocity. CJS under ESM requires default-import interop. |
| `commander` v15 for CLI | Native ESM, proper choices/coercion, `exitOverride` for testability. |
| Video-only MP4 for MIDI input | MIDI has no audio track to mux; synthesis is out of scope for M1. Audio input muxes the original file. |
| Closed-form SUVAT over simulation | Exact solution: `vy = (dy - 0.5*g*t^2) / t`. No iteration, no numerical drift. Arrival accuracy ~1e-11 px. |

## Correctness Properties (Property-Based Tests)

The solver's correctness is validated by 12 fast-check properties:

| # | Property | Requirement |
|---|----------|-------------|
| 1 | Ballistic arc arrival < 0.001 px | 4.1 |
| 2 | Impact timing within +/-15ms | 4.2 |
| 3 | Within-arc SUVAT physical consistency | 4.3 |
| 4 | Keyframe tSec strictly ascending | 4.4 |
| 5 | Pitch-to-X monotonically non-decreasing | 3.1 |
| 6 | All target positions within canvas bounds | 3.2 |
| 7 | Velocity-to-impact monotonically non-decreasing | 3.3 |
| 8 | Pitch class color consistency (P == P+12) | 3.4 |
| 9 | Output sorted by timeSec | 3.6 |
| 10 | Note ID uniqueness | 2.5 |
| 11 | Velocity normalization = value/127 | 2.3 |
| 12 | Data contract validation correctness | 8.1 |

## Extending the Project

### Adding a new input format (e.g., MusicXML)

Create an adapter in `packages/note-extractor` that produces `NoteEvent[]`. Wire it into `extract()` with a new extension check. No downstream changes needed.

### Adding a new visual style

1. Add a new layout strategy in `packages/musical-mapper` (the `LayoutConfig.type` field)
2. Update the renderer to draw targets differently based on layout type
3. The trajectory solver, validator, and export stages are style-agnostic

### Adding audio synthesis for MIDI output

Currently MIDI input produces a video-only MP4. To add synthesized audio:
1. Add a synthesis package (e.g., soundfont rendering)
2. Wire it into the CLI pipeline between solve and render
3. Use `exportVideo` (with audio muxing) instead of `exportVideoOnly`

### Improving render quality (M3 goals from the design)

The renderer is currently 2D canvas-based. The architecture supports swapping it:
1. Keep the same `ObjectTrajectory` → frame-file contract
2. Replace the renderer internals (e.g., with Three.js for 3D, camera moves, advanced effects)
3. Everything else (solver, export, CLI) stays unchanged

## Troubleshooting

### `ffmpeg was not found or is not runnable`

Install ffmpeg and ensure it's on your PATH:
- Windows: `winget install ffmpeg` or download from https://ffmpeg.org/download.html
- macOS: `brew install ffmpeg`
- Linux: `sudo apt install ffmpeg`

Or set `FFMPEG_PATH` to the ffmpeg binary location.

### Audio analysis fails or Python/librosa cannot be found

Run the setup script to install the project audio-analysis environment. The default `auto`, `beats`, and `onsets` modes require librosa; only `--mode notes` requires Basic Pitch:

```powershell
# Windows
.\scripts\setup-audio.ps1
```

```bash
# macOS / Linux
./scripts/setup-audio.sh
```

Then set the `PYTHON` env var to point at the venv:

```powershell
# Windows (PowerShell)
$env:PYTHON = "$PWD\.venv\Scripts\python.exe"
npx motionscore song.wav -o out.mp4
```

```bash
# macOS / Linux
PYTHON=.venv/bin/python npx motionscore song.wav -o out.mp4
```

For the web server, set `PYTHON` before starting:

```powershell
$env:PYTHON = "$PWD\.venv\Scripts\python.exe"
npm run web:start
```

### `@tonejs/midi` import errors

This package is CJS. Under ESM it must be default-imported:
```typescript
import midiModule from '@tonejs/midi';
const { Midi } = midiModule;
```

A named import `import { Midi } from '@tonejs/midi'` will crash at runtime.

## License

Private project (not published to npm).
