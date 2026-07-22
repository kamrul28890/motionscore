# MotionScore

A CLI-based music-to-physics video generator. Feed it a MIDI file (or audio, with Basic Pitch installed) and it produces an H.264 MP4 where a ball moves under realistic gravity, striking targets in exact sync with every note.

## Quick Start

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run on a MIDI file
npx motionscore song.mid -o output.mp4

# Run with custom settings
npx motionscore song.mid -o output.mp4 --fps 30 --width 1280 --height 720 --verbose
```

## Requirements

- **Node.js** >= 22.12 (tested on Node 26)
- **ffmpeg** on PATH ([download](https://ffmpeg.org/download.html)) - required for video export
- **Python 3 + Basic Pitch** (optional) - only needed for audio input (`.wav`/`.mp3`/`.flac`/`.ogg`)

```bash
# Install Basic Pitch for audio support (optional)
pip install basic-pitch
```

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
  --verbose               print progress information for each pipeline stage
  -h, --help              display help for command
```

### Examples

```bash
# Basic MIDI to video
npx motionscore song.mid -o video.mp4

# Lower resolution for faster rendering
npx motionscore song.mid -o video.mp4 --width 640 --height 360 --fps 30

# Audio input (requires Basic Pitch)
npx motionscore recording.wav -o video.mp4

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
  note-extractor/     Stage B: MIDI parsing + Basic Pitch audio transcription
  musical-mapper/     Stage C: pitch-to-position, color, density filtering
  trajectory-solver/  Stage D: SUVAT ballistic arc solver (core IP)
  renderer/           Stage E: headless PNG frame rendering (@napi-rs/canvas)
  video-export/       Stage F: ffmpeg H.264 muxing (fluent-ffmpeg)
  cli/                CLI entry point wiring all stages together
```

## Pipeline Overview

```
Input (.mid or .wav/.mp3/.flac/.ogg)
  |
  v
Stage B: Note Extraction
  - MIDI: parse directly (@tonejs/midi)
  - Audio: transcribe via Basic Pitch -> parse generated MIDI
  -> NoteEvent[] (pitch, timing, velocity, track)
  |
  v
Stage C: Musical Mapping
  - Pitch -> x-position (linear piano-key layout)
  - Pitch -> color (circle-of-fifths palette)
  - Velocity -> impact size
  - Optional density filtering (notes-per-second cap)
  -> ChoreographyTarget[] (position, time, color, impact)
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
```

### Running Tests

```bash
# Full suite (93 tests across 15 files)
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
  pitchMidi: number;       // [0, 127]
  startSec: number;        // >= 0
  endSec: number;          // > startSec
  velocity: number;        // [0.0, 1.0] (midiVelocity / 127)
  track?: string;          // Source track name
  instrument?: string;
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

### Audio input fails with "Basic Pitch exited with code 1"

Install the Basic Pitch Python package:
```bash
pip install basic-pitch
```

If Python is installed under a different name (e.g., `python3`), set the `PYTHON` environment variable:
```bash
PYTHON=python3 npx motionscore song.wav -o out.mp4
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
