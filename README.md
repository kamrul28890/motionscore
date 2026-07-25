# MotionScore

MotionScore turns an audio file into a live, physics-driven music visualization.
It separates the song into instrument components with Demucs, analyzes rhythm,
pitch, activity, and song structure, then renders synchronized balls and tracks
in the browser.

The interface is organized around two focused workspaces:

- **Source Lab** — compare the original mix with separated components, play,
  mute, solo, adjust, or download individual stems, and inspect the analysis.
- **Scene Controls** — group sounds into balls, rename and recolor them, change
  their height and tilt, and control which actors appear in the visualization.

## Origin and attribution

This project started from the original
[`BaselAshraf81/lineridervisualizer`](https://github.com/BaselAshraf81/lineridervisualizer)
repository. I used that repository as the foundation, then modified and extended
it with a rebuilt analysis pipeline, neural stem separation, synchronized stem
playback, richer progress reporting, analysis diagnostics, scene authoring
controls, new documentation, and a redesigned interface.

The upstream repository does not currently include a license file. Review the
original project's terms and obtain any necessary permission before
redistributing the software.

## Highlights

- Six-source `htdemucs_6s` separation: drums, bass, vocals, guitar, piano, other
- Playable and downloadable stem components
- Per-instrument onset, activity, sustain, and pitch analysis
- Live canvas animation synchronized to the master audio timeline
- One visual actor per detected role, with configurable grouping
- Named progress stages from upload through result encoding
- CUDA acceleration with automatic CPU fallback
- Local processing: uploaded audio does not need to leave the computer

## Pipeline summary

```text
Audio upload
    → Demucs source separation
    → librosa event, pitch, energy, and structure analysis
    → validated AudioAnalysis JSON
    → synchronized stem player and 2D physics scene
```

The animation is deterministic: the audio player's current time is the master
clock, so playback, pausing, seeking, stems, and the visualization stay aligned.

For the complete stage-by-stage explanation, JSON examples, validation rules,
model details, and animation mappings, see
[`ARCHITECTURE_AND_PIPELINE_GUIDE.md`](ARCHITECTURE_AND_PIPELINE_GUIDE.md).

## Requirements

- Node.js 20 or newer
- Python 3.10 or newer
- FFmpeg on `PATH`
- An NVIDIA CUDA-capable GPU is recommended; CPU fallback works but is slower

## Quick start on Windows

```powershell
npm install
.\scripts\setup.ps1
npm run web:build
npm run web:start
```

Open [http://localhost:3001](http://localhost:3001), choose an audio file, and
select **Generate visualization**.

For a computer without an NVIDIA GPU:

```powershell
.\scripts\setup.ps1 -Cpu
```

The first analysis downloads the approximately 170 MB `htdemucs_6s` model and
caches it for later runs.

## Development

```powershell
npm run web:dev
npm run typecheck
npm test
npm run web:build
```

## Repository map

```text
packages/types/           Shared analysis contracts and validation
packages/note-extractor/  TypeScript wrapper and Python audio analyzer
packages/web/             Express API and React/Vite application
scripts/                  Windows and Unix environment setup
test/                     Pipeline and scene tests
```

Temporary uploads and generated stems are removed automatically after the job
retention period.
