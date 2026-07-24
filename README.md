# MotionScore

Turn a song into a live, physics-driven visualization in the browser. Upload an
audio file and MotionScore separates it into real instruments with a neural
model (Demucs), then draws a small cast of balls that move under gravity and
strike physical lines exactly when each instrument plays — a DoodleChaos-style
"the music decides where the ball must be, the track is drawn to justify it"
scene, rendered live on an HTML5 canvas in sync with playback.

It is a web app. There is no baked video and no MIDI/other-mode paths — just
audio in, a live neural-driven 2D scene out.

## Quick start

```bash
# 1. Install Node dependencies
npm install

# 2. Set up the Python analysis environment (PyTorch + Demucs + librosa)
#    Windows (PowerShell):
.\scripts\setup.ps1            # add -Cpu on a machine without an NVIDIA GPU
#    macOS / Linux:
./scripts/setup.sh             # add --cpu on a machine without an NVIDIA GPU

# 3. Build and run
npm run web:build
npm run web:start
# open http://localhost:3001
```

Then drop an audio file (`.mp3`, `.wav`, `.flac`, `.ogg`) onto the page and press
Generate. The first run downloads the ~170 MB `htdemucs_6s` model automatically.

For development with hot reload:

```bash
npm run web:dev        # Express API (:3001) + Vite client (:5173)
```

## Requirements

- **Node.js** >= 20
- **Python** 3.10+ (the setup script creates a local `.venv`)
- **An NVIDIA GPU is strongly recommended.** Separation runs on CUDA when
  available and falls back to CPU, which is much slower. `ffmpeg` on PATH is
  recommended so librosa can decode compressed audio (mp3/ogg).

The setup script installs everything into `.venv/`. The web server auto-detects
`.venv` at startup; you normally do not need to set `PYTHON` yourself. To point
at a specific interpreter:

```powershell
$env:PYTHON = "$PWD\.venv\Scripts\python.exe"   # Windows
```
```bash
export PYTHON="$PWD/.venv/bin/python"           # macOS / Linux
```

## How it works

```
audio file
   |
   v  packages/note-extractor  (Python subprocess: Demucs htdemucs_6s)
   |    separate stems -> per-stem onsets + 10 Hz features + section cues
   |    + compact per-role neural signals (activity / sustains / pitch dir)
   v
AudioAnalysis  (packages/types data contract)
   |
   v  packages/web server  (POST /api/generate -> SSE progress -> /api/result)
   |
   v  packages/web client  (scene2d: buildScene2D -> renderScene2D on <canvas>)
        the browser plays the original audio (/api/audio) as the master clock
```

The analyzer separates the mix into six sources (`drums`, `bass`, `other`,
`vocals`, `guitar`, `piano`); drums are band-split into kick/snare/percussion.
Each instrument becomes its own ball by default. The scene planner places a
music-fixed contact at every onset and solves the motion between contacts
backward (exact constant-gravity arcs, plus sustained rails from the neural
activity signal), so every ball lands on its line exactly on the beat.

The live scene is deterministic: every frame is a pure function of the audio
clock time, so playback, pausing, and seeking all stay in sync.

## Using the scene

- **One ball per instrument** by default, each named and coloured by its sound.
- **Drag a sound chip into another ball** to group instruments, or onto
  "New ball" to split one out. Rename, recolour, and show/hide each ball.
- **Height / Tilt** sliders manually nudge a ball's line up/down and its angle,
  so you can control how the balls weave and intersect.

## Project layout

TypeScript monorepo (npm workspaces, `tsc -b`) with three packages:

```
packages/
  types/           Shared data contracts (NoteEvent, AudioAnalysis, RoleSignals,
                   HitRole + role palette/labels) + the NoteEvent validator.
  note-extractor/  Neural audio analysis. TS wrapper spawns the Python analyzer,
                   validates its JSON, and returns AudioAnalysis (+ a compact
                   summary). Python: extract_stems.py (Demucs) with extract_events.py
                   as a shared DSP helper module.
  web/             The product. Express server (src/server.ts) + React/Vite client
                   (src/client). The live scene lives in src/client/src/scene2d.
scripts/
  setup.ps1 / setup.sh   One-step Python env (venv + librosa + PyTorch + Demucs).
```

See [`MEMORY.md`](MEMORY.md) for a detailed codebase map (intended for both new
contributors and AI assistants).

## HTTP API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/generate` | Upload an audio file (multipart `file`), returns `{ jobId }` |
| GET | `/api/progress/:jobId` | Server-Sent Events stream of analysis progress |
| GET | `/api/result/:jobId` | `{ durationSec, audioUrl, analysis }` (the full `AudioAnalysis`) |
| GET | `/api/audio/:jobId` | Streams the original uploaded audio (the playback clock) |

Uploaded files are cleaned up ~30 minutes after a job finishes.

## Development

```bash
npm run build        # tsc -b (types + note-extractor)
npm run typecheck    # same as build
npm test             # vitest
npm run web:dev      # hot-reload client + server
npm run web:build    # build client bundle + server
npm run web:start    # run the production server on :3001
```

## Troubleshooting

**Analysis fails / Python or Demucs not found.** Re-run the setup script and make
sure `.venv/` exists in the project root. On a machine without an NVIDIA GPU, run
it with `-Cpu` (Windows) / `--cpu` (macOS/Linux); separation will be slow but works.

**mp3/ogg won't decode.** Install `ffmpeg` and make sure it is on PATH.

**Separation is very slow.** That is CPU separation. Use a CUDA-capable NVIDIA
GPU for realtime-ish analysis.

## License

Private project (not published to npm).
