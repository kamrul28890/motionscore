# Requirements Document

## Introduction

MotionScore is a CLI-based music-to-physics video generator that takes audio or MIDI input and produces a video where a physical object strikes targets in sync with musical notes. The system is structured as a modular pipeline (Note Extraction → Musical Mapping → Trajectory Solving → Simulation/Rendering → Video Export) with typed data contracts between stages. This document defines the formal requirements for the M1 (correctness prototype) and M2 (audio input) milestones.

## Glossary

- **Pipeline**: The sequential processing chain that transforms input music into output video
- **NoteEvent**: A data structure representing a single musical note with pitch, timing, and velocity
- **ChoreographyTarget**: A positioned, timed target that the physics object must hit
- **TrajectoryKeyframe**: A time-stamped position/velocity snapshot of the physics object
- **ObjectTrajectory**: The complete sequence of keyframes describing the object's motion
- **BallisticArc**: A parabolic path segment computed using SUVAT kinematics
- **SUVAT**: Kinematic equations relating displacement, initial velocity, final velocity, acceleration, and time
- **NoteExtractor**: The module responsible for converting input files to NoteEvent arrays
- **MusicalMapper**: The module responsible for converting NoteEvents to ChoreographyTargets
- **TrajectorySolver**: The core module that computes physically-plausible arcs hitting targets on time
- **Renderer**: The module that produces visual frame output from trajectory data
- **VideoExporter**: The module that muxes frames and audio into a final video file
- **CLI**: The command-line interface entry point for the application
- **SyncTolerance**: The maximum acceptable timing error between computed impact and note onset (±15ms)
- **BasicPitch**: Spotify's open-source audio-to-MIDI transcription model (Apache 2.0)

## Requirements

### Requirement 1: CLI Interface and Pipeline Orchestration

**User Story:** As a user, I want to run a single CLI command with my music file and get a synced physics video as output, so that I can generate videos without manual intervention.

#### Acceptance Criteria

1. WHEN a user invokes `motionscore <input> -o <output>`, THE CLI SHALL detect the input file format by extension (.mid/.midi for MIDI, .wav/.mp3/.flac/.ogg for audio) and route to the appropriate extraction module
2. WHEN the input file does not exist or is unreadable, THE CLI SHALL exit with a non-zero code and a descriptive error message including the file path
3. WHEN the pipeline completes successfully, THE CLI SHALL output the video file at the specified path and print summary statistics (total notes, rendered frames, duration, max sync error)
4. THE CLI SHALL support the following optional flags: `--fps` (default 60), `--width` (default 1920), `--height` (default 1080), `--layout` (default 'piano-keys'), `--verbose`
5. WHEN `--verbose` is specified, THE CLI SHALL print progress information for each pipeline stage as it executes

### Requirement 2: MIDI Note Extraction

**User Story:** As a user, I want to provide a MIDI file and have it accurately parsed into note events, so that the pipeline has precise timing and pitch data to work with.

#### Acceptance Criteria

1. WHEN a valid MIDI file is provided, THE NoteExtractor SHALL parse it into a NoteEvent array containing all note-on/note-off events with correct pitch, onset time (seconds), offset time (seconds), and velocity
2. WHEN parsing a MIDI file, THE NoteExtractor SHALL convert MIDI tick timing to seconds using the file's tempo map
3. WHEN parsing a MIDI file, THE NoteExtractor SHALL normalize velocity values from MIDI range [0, 127] to [0.0, 1.0]
4. WHEN a MIDI file contains multiple tracks, THE NoteExtractor SHALL preserve track names and assign them to the corresponding NoteEvent `track` field
5. THE NoteExtractor SHALL assign a unique `id` to each extracted NoteEvent
6. WHEN a MIDI file is malformed or contains no note events, THE NoteExtractor SHALL throw an InputError with a descriptive message

### Requirement 3: Musical Mapping (Note to Target Conversion)

**User Story:** As a user, I want notes to be intelligently mapped to screen positions and colors, so that the visual layout is legible and aesthetically pleasing.

#### Acceptance Criteria

1. WHEN mapping notes to positions using 'piano-keys' layout, THE MusicalMapper SHALL assign x-positions such that higher MIDI pitches map to higher x-coordinates (monotonically non-decreasing)
2. WHEN mapping notes, THE MusicalMapper SHALL ensure all target positions are within the configured canvas bounds (x in [0, canvasWidth], y in [0, canvasHeight])
3. WHEN mapping velocity to impact size, THE MusicalMapper SHALL produce values in [0.0, 1.0] that are monotonically non-decreasing with respect to input velocity (louder notes → larger impacts)
4. WHEN using 'circle-of-fifths' color scheme, THE MusicalMapper SHALL assign the same color to all notes of the same pitch class regardless of octave
5. WHEN note density exceeds a configurable threshold (maxNotesPerSecond), THE MusicalMapper SHALL filter notes by priority (preferring higher velocity and configured track priority) while preserving the remaining notes' timing
6. THE MusicalMapper SHALL output ChoreographyTargets sorted by timeSec in ascending order

### Requirement 4: Trajectory Solving (Core Physics)

**User Story:** As a user, I want the ball's motion to be physically plausible and frame-accurately synced, so that impacts feel natural and land precisely on the musical beats.

#### Acceptance Criteria

1. WHEN computing a ballistic arc between two points, THE TrajectorySolver SHALL use SUVAT kinematics to produce an initial velocity that causes the object to arrive at the target position within floating-point tolerance (< 0.001 pixels) after the specified duration
2. WHEN solving a complete trajectory, THE TrajectorySolver SHALL produce impact keyframes whose timestamps are within ±15ms (configurable via syncToleranceMs) of each target's specified timeSec
3. WHEN generating keyframes between impacts, THE TrajectorySolver SHALL ensure physical consistency: each keyframe's position is derivable from the previous keyframe's position and velocity plus gravitational acceleration over elapsed time
4. THE TrajectorySolver SHALL produce keyframes in strictly ascending temporal order (keyframes[i].tSec < keyframes[i+1].tSec for all consecutive pairs)
5. IF two consecutive targets require an arc with velocity exceeding a configurable maximum, THEN THE TrajectorySolver SHALL log a warning and either skip the unreachable target or insert an intermediate waypoint
6. THE TrajectorySolver SHALL accept style parameters (maxApexHeight, preferredArcRatio) that influence arc shape without violating timing constraints

### Requirement 5: Simulation and Rendering

**User Story:** As a user, I want the output video to show a ball moving with clear visual impacts, trails, and effects, so that the result looks polished and engaging.

#### Acceptance Criteria

1. WHEN rendering frames, THE Renderer SHALL interpolate the ball position from trajectory keyframes at the configured FPS to produce smooth motion
2. WHEN a keyframe with `hitsTarget` is reached, THE Renderer SHALL trigger a visual impact effect (particle burst) at the target position
3. THE Renderer SHALL draw all choreography targets as visible elements (piano keys or lane markers) in their assigned positions and colors
4. WHEN trail rendering is enabled, THE Renderer SHALL draw a fading trail behind the ball showing its recent path
5. THE Renderer SHALL export each frame as a numbered PNG file in the configured output directory
6. IF rendering a frame fails, THEN THE Renderer SHALL log the error and continue with subsequent frames, aborting only if more than 5% of total frames fail

### Requirement 6: Video Export

**User Story:** As a user, I want the final output to be a standard MP4 video with the original audio synced to the visual, so that I can share it directly.

#### Acceptance Criteria

1. WHEN exporting video, THE VideoExporter SHALL mux the rendered frame sequence with the original audio file into an MP4 container using ffmpeg
2. WHEN export begins, THE VideoExporter SHALL verify ffmpeg is available on PATH and throw an ExportError with installation instructions if not found
3. THE VideoExporter SHALL use H.264 codec with configurable CRF quality (default 18) for the video stream
4. WHEN export completes successfully, THE VideoExporter SHALL produce a video file whose duration matches the input audio duration within ±100ms

### Requirement 7: Audio Transcription (M2)

**User Story:** As a user, I want to provide an audio file (WAV, MP3, FLAC) and have it automatically transcribed to MIDI, so that I don't need to source MIDI files separately.

#### Acceptance Criteria

1. WHEN an audio file is provided, THE NoteExtractor SHALL invoke Basic Pitch as a Python subprocess to transcribe the audio to MIDI
2. WHEN Basic Pitch transcription completes, THE NoteExtractor SHALL parse the generated MIDI output using the same MIDI parsing path as direct MIDI input
3. IF the Python environment or Basic Pitch package is not available, THEN THE NoteExtractor SHALL throw a TranscriptionError with installation instructions
4. IF the Basic Pitch subprocess exits with a non-zero code, THEN THE NoteExtractor SHALL include the subprocess stderr in the error message
5. WHEN transcribing audio, THE NoteExtractor SHALL pass the generated MIDI through the same validation as direct MIDI input (unique IDs, normalized velocity, correct timing)

### Requirement 8: Data Contract Validation

**User Story:** As a developer, I want typed data contracts between pipeline stages validated at runtime, so that bugs in one stage produce clear errors rather than silent corruption downstream.

#### Acceptance Criteria

1. THE Pipeline SHALL validate NoteEvent arrays at the boundary between Stage B and Stage C: pitchMidi in [0, 127], startSec >= 0, endSec > startSec, velocity in [0.0, 1.0], non-empty unique id
2. THE Pipeline SHALL validate ChoreographyTarget arrays at the boundary between Stage C and Stage D: valid noteId reference, timeSec >= 0, position within canvas bounds, impactSize in [0.0, 1.0], valid hex color
3. THE Pipeline SHALL validate ObjectTrajectory at the boundary between Stage D and Stage E: keyframes sorted by tSec ascending, impact keyframes within syncTolerance of referenced targets
4. IF validation fails at any stage boundary, THEN THE Pipeline SHALL throw a ValidationError identifying the stage, the invalid field, and the actual value
