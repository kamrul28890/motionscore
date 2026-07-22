# Implementation Plan: MotionScore

## Overview

This plan implements MotionScore as a TypeScript monorepo with independent packages for each pipeline stage. Tasks focus on M1 (correctness prototype: MIDI → ballistic solver → render → export) and M2 (audio input via Basic Pitch). Each task builds on previous ones, wiring components together incrementally so there is no orphaned code.

## Tasks

- [ ] 1. Set up monorepo structure and shared types
  - [-] 1.1 Initialize monorepo with TypeScript project structure
    - Create root `package.json` with workspaces: `packages/types`, `packages/note-extractor`, `packages/musical-mapper`, `packages/trajectory-solver`, `packages/renderer`, `packages/video-export`, `packages/cli`
    - Configure root `tsconfig.json` with strict mode and project references
    - Set up Vitest config at root level with workspace support
    - Install shared dev dependencies: `typescript`, `vitest`, `fast-check`
    - _Requirements: 1.1, 1.4_

  - [~] 1.2 Define shared data contract interfaces (`packages/types`)
    - Create `NoteEvent`, `ChoreographyTarget`, `TrajectoryKeyframe`, `ObjectTrajectory` interfaces
    - Create configuration interfaces: `CLIOptions`, `LayoutConfig`, `SolverConfig`, `RenderConfig`, `ExportConfig`
    - Create error types: `InputError`, `TranscriptionError`, `ExportError`, `ValidationError`
    - Export all types from package entry point
    - _Requirements: 8.1, 8.2, 8.3_

  - [~] 1.3 Implement data contract validators (`packages/types/validators`)
    - Write `validateNoteEvents(events: NoteEvent[]): void` — checks pitchMidi [0,127], startSec >= 0, endSec > startSec, velocity [0.0,1.0], unique ids
    - Write `validateChoreographyTargets(targets: ChoreographyTarget[], canvasWidth, canvasHeight): void` — checks bounds, valid noteId refs, timeSec >= 0
    - Write `validateObjectTrajectory(trajectory: ObjectTrajectory, targets: ChoreographyTarget[], toleranceMs): void` — checks temporal ordering, timing tolerance
    - Each validator throws `ValidationError` with stage, field, and value on failure
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ]* 1.4 Write property tests for data contract validators
    - **Property 12: Data contract validation correctness**
    - Generate valid NoteEvent arrays with fast-check, verify validator accepts
    - Generate invalid NoteEvent arrays (out-of-range fields), verify validator rejects
    - **Validates: Requirement 8.1**

- [ ] 2. Implement MIDI note extraction (Stage B)
  - [~] 2.1 Implement MIDI parser (`packages/note-extractor`)
    - Install `@tonejs/midi` dependency
    - Implement `parseMidi(filePath: string): Promise<NoteEvent[]>` function
    - Convert MIDI ticks to seconds using tempo map from the MIDI file
    - Normalize velocity from [0, 127] to [0.0, 1.0] via linear division
    - Assign unique IDs (`n0001`, `n0002`, ...) to each note event
    - Preserve track names from MIDI file structure
    - Throw `InputError` for malformed files or files with zero note events
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 2.2 Write property tests for MIDI velocity normalization and ID uniqueness
    - **Property 11: MIDI velocity normalization** — for any integer in [0,127], output is in [0.0,1.0] and equals value/127
    - **Property 10: Note ID uniqueness** — for any parsed output, all IDs are distinct
    - **Validates: Requirements 2.3, 2.5**

- [ ] 3. Implement musical mapping (Stage C)
  - [~] 3.1 Implement pitch-to-position mapping (`packages/musical-mapper`)
    - Implement `pitchToX(pitchMidi, canvasWidth, pitchRange): number` — linear mapping clamped to [0, canvasWidth]
    - Implement `pitchToColor(pitchMidi): string` — circle-of-fifths color mapping returning hex strings
    - Implement `velocityToImpactSize(velocity): number` — pass-through (already in [0.0, 1.0])
    - _Requirements: 3.1, 3.3, 3.4_

  - [~] 3.2 Implement full musical mapper with note filtering
    - Implement `mapNotes(notes: NoteEvent[], config: LayoutConfig): ChoreographyTarget[]`
    - Map each note: pitch → x-position, config.targetY → y-position, velocity → impactSize, pitch → colorHint
    - Implement density filtering: if notes-per-second exceeds `maxNotesPerSecond`, keep highest-velocity notes
    - Sort output by timeSec ascending
    - Run validator on output before returning
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 3.3 Write property tests for musical mapper
    - **Property 5: Pitch-to-position monotonicity** — for any pitchA < pitchB, x(A) <= x(B)
    - **Property 6: Choreography target bounds preservation** — all positions within canvas bounds
    - **Property 7: Velocity-to-impact monotonicity** — vA < vB implies impactSize(A) <= impactSize(B)
    - **Property 8: Pitch class color consistency** — color(P) == color(P+12) for any P
    - **Property 9: Output ordering** — output sorted by timeSec
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6**

- [~] 4. Checkpoint - Core data pipeline
  - Ensure all tests pass, ask the user if questions arise.
  - Verify: MIDI file → NoteEvent[] → ChoreographyTarget[] works end-to-end with a test MIDI file.

- [ ] 5. Implement trajectory solver (Stage D — Core IP)
  - [~] 5.1 Implement ballistic arc calculator
    - Implement `computeBallisticArc(startPos, endPos, duration, gravity): BallisticArc`
    - Apply SUVAT: `vx = (endX - startX) / t`, `vy = (endY - startY - 0.5*g*t^2) / t`
    - Compute apex position for style information
    - Validate inputs (duration > 0, gravity > 0) and throw on invalid
    - _Requirements: 4.1_

  - [ ]* 5.2 Write property tests for ballistic arc calculator
    - **Property 1: Ballistic arc arrival accuracy** — simulate arc forward, verify arrival within 0.001 pixels
    - Generate random start/end positions (within reasonable bounds), random durations (0.05s to 5s), random gravity (100-2000)
    - **Validates: Requirement 4.1**

  - [~] 5.3 Implement trajectory chaining solver
    - Implement `solveTrajectory(targets: ChoreographyTarget[], config: SolverConfig): ObjectTrajectory`
    - Sort targets by timeSec, compute arc between each consecutive pair
    - Generate intermediate keyframes at configured FPS density between impacts
    - Mark impact keyframes with `hitsTarget` = target's noteId
    - Handle edge case: if arc velocity exceeds maximum, log warning and skip target
    - Accept style parameters (maxApexHeight, preferredArcRatio) — for M1 these are pass-through; actual arc shaping deferred to M3
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

  - [ ]* 5.4 Write property tests for trajectory solver
    - **Property 2: Trajectory timing accuracy** — all impact keyframes within ±15ms of target timeSec
    - **Property 3: Physical consistency** — consecutive keyframes consistent with SUVAT
    - **Property 4: Keyframe temporal ordering** — strictly ascending tSec
    - Generate random target sequences (2-20 targets, sorted by time, reasonable spacing)
    - **Validates: Requirements 4.2, 4.3, 4.4**

- [~] 6. Checkpoint - Solver correctness
  - Ensure all tests pass, ask the user if questions arise.
  - Verify: ChoreographyTarget[] → ObjectTrajectory with timing within tolerance.

- [ ] 7. Implement simulation and rendering (Stage E)
  - [~] 7.1 Implement frame renderer (`packages/renderer`)
    - Install `pixi.js` and `@pixi/node` (headless Node.js rendering)
    - Implement `render(trajectory, targets, config): Promise<string[]>`
    - Initialize PixiJS application in headless mode with configured width/height
    - For each frame at configured FPS: interpolate ball position from keyframes, draw ball circle, draw target elements (rectangles for piano keys) in their colorHint, export frame as PNG
    - On impact frames (hitsTarget set): trigger particle burst effect (simple expanding circles)
    - Implement trail rendering: maintain last N positions, draw fading line
    - Number frames sequentially (`frame_00001.png`, `frame_00002.png`, ...)
    - Handle render errors: log and continue, abort if >5% frames fail
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [ ] 8. Implement video export (Stage F)
  - [~] 8.1 Implement ffmpeg video exporter (`packages/video-export`)
    - Install `fluent-ffmpeg` dependency
    - Implement pre-flight check: verify `ffmpeg` exists on PATH, throw `ExportError` with install instructions if not
    - Implement `exportVideo(config: ExportConfig): Promise<string>`
    - Configure ffmpeg: input frame sequence (pattern), input audio file, output MP4 with H.264 codec, CRF from config (default 18)
    - Set frame rate to match configured FPS
    - Report progress via callback during encoding
    - Return output file path on success
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 9. Implement CLI entry point and wire pipeline
  - [~] 9.1 Implement CLI argument parser (`packages/cli`)
    - Install `commander` dependency
    - Define CLI with: positional `input` argument, required `-o`/`--output` option
    - Define optional flags: `--fps` (number, default 60), `--width` (number, default 1920), `--height` (number, default 1080), `--layout` (choice: piano-keys|lanes, default piano-keys), `--verbose` (boolean)
    - Detect input type by extension: `.mid`/`.midi` → MIDI path, `.wav`/`.mp3`/`.flac`/`.ogg` → audio path
    - Validate input file exists before proceeding
    - _Requirements: 1.1, 1.2, 1.4_

  - [~] 9.2 Wire complete pipeline in CLI main function
    - Import all stage modules
    - Implement sequential pipeline: detect input → extract notes → validate → map → validate → solve → validate → render → export
    - On success: print stats (total notes, rendered frames, duration, max sync error)
    - On error: print descriptive error message, exit with code 1
    - When `--verbose`: print stage name and timing for each step
    - Add data contract validation calls at each stage boundary
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 8.1, 8.2, 8.3, 8.4_

  - [~] 9.3 Add npm bin script and build configuration
    - Add `"bin": { "motionscore": "./dist/cli/index.js" }` to root package.json
    - Configure TypeScript build to output to `dist/`
    - Add `"build"` and `"start"` scripts
    - Verify `npx motionscore --help` works after build
    - _Requirements: 1.1, 1.4_

- [~] 10. Checkpoint - End-to-end M1
  - Ensure all tests pass, ask the user if questions arise.
  - Verify: `motionscore test.mid -o output.mp4` produces a valid video with synced impacts.

- [ ] 11. Implement audio transcription support (M2)
  - [~] 11.1 Implement Basic Pitch subprocess wrapper
    - Implement `transcribeAudio(audioPath: string): Promise<string>` — returns path to generated MIDI file
    - Spawn `python -m basic_pitch <outputDir> <audioPath>` as child process
    - Capture stdout/stderr for error reporting
    - On non-zero exit: throw `TranscriptionError` with stderr content and install instructions
    - On missing Python: throw `TranscriptionError` with Python/Basic Pitch install instructions
    - Write generated MIDI to a temp directory, return the file path
    - _Requirements: 7.1, 7.3, 7.4_

  - [~] 11.2 Wire audio transcription into note extractor
    - Update `NoteExtractor` to check file extension: if audio format, call `transcribeAudio()` first
    - Pass generated MIDI file through existing `parseMidi()` function
    - Apply same validation to transcription output as direct MIDI input
    - Clean up temp MIDI file after successful parsing
    - _Requirements: 7.1, 7.2, 7.5_

  - [ ]* 11.3 Write integration test for audio transcription path
    - Test with a short test WAV file (generate a simple sine wave MIDI → WAV for testing)
    - Verify output NoteEvent[] has valid structure and reasonable note count
    - Verify error handling when Basic Pitch is not installed
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [~] 12. Final checkpoint - M1 + M2 complete
  - Ensure all tests pass, ask the user if questions arise.
  - Verify: both `motionscore test.mid -o out.mp4` and `motionscore test.wav -o out.mp4` produce valid output.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at meaningful boundaries
- Property tests validate universal correctness properties from the design document
- The trajectory solver (tasks 5.x) is the core IP and should receive the most testing attention
- M3 aesthetic tasks (particles, camera, color grading, Jolt upgrade) are intentionally out of scope for this plan
- All packages use strict TypeScript with explicit types — no `any` allowed
- fast-check is used for all property-based tests, integrated with Vitest

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "2.1"] },
    { "id": 3, "tasks": ["1.4", "2.2", "3.1"] },
    { "id": 4, "tasks": ["3.2"] },
    { "id": 5, "tasks": ["3.3", "5.1"] },
    { "id": 6, "tasks": ["5.2", "5.3"] },
    { "id": 7, "tasks": ["5.4", "7.1"] },
    { "id": 8, "tasks": ["8.1"] },
    { "id": 9, "tasks": ["9.1"] },
    { "id": 10, "tasks": ["9.2"] },
    { "id": 11, "tasks": ["9.3"] },
    { "id": 12, "tasks": ["11.1"] },
    { "id": 13, "tasks": ["11.2"] },
    { "id": 14, "tasks": ["11.3"] }
  ]
}
```
