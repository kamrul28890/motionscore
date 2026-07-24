// @motionscore/note-extractor — stem-aware rhythmic audio analysis
//
// Runs the Python neural analyzer (Demucs `htdemucs_6s`) as a subprocess,
// validates its JSON output, and converts it into the typed AudioAnalysis:
// per-stem onsets (NoteEvent[]), 10 Hz feature frames, structural section cues,
// and compact per-role neural signals.

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROLE_ORDER,
  TranscriptionError,
  type AudioAnalysis,
  type AudioAnalysisMode,
  type AudioFeatureFrame,
  type HitRole,
  type NoteEvent,
  type PitchDirection,
  type RoleSignalTrack,
  type RoleSignals,
  type SectionCue,
  type SustainSpan,
} from '@motionscore/types';

const PYTHON_ENV_VAR = 'PYTHON';
const DEFAULT_PYTHON = 'python';
/** Neural per-instrument analyzer (Demucs `htdemucs_6s`). */
const STEMS_SCRIPT_PATH = fileURLToPath(new URL('../python/extract_stems.py', import.meta.url));
const EVENT_DURATION_SEC = 0.12;
const NOTE_ID_DIGITS = 4;
/** Safety bound for a hung decoder/analyzer subprocess. */
const ANALYZER_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Whether neural stems analysis can run on a GPU here: torch + demucs importable
 * AND CUDA available. Probed once and cached. Lets callers prefer `stems`
 * automatically when it will be fast, without forcing slow CPU separation on
 * machines that lack a GPU (or the deps). Never throws — resolves false on any
 * problem.
 */
let stemsGpuProbe: Promise<boolean> | undefined;

export function detectStemsGpuAvailable(): Promise<boolean> {
  if (stemsGpuProbe === undefined) stemsGpuProbe = probeStemsGpu();
  return stemsGpuProbe;
}

function probeStemsGpu(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const python = process.env[PYTHON_ENV_VAR] ?? DEFAULT_PYTHON;
    let settled = false;
    const done = (value: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn(
        python,
        ['-c', 'import torch,demucs;print(1 if torch.cuda.is_available() else 0)'],
        { shell: false, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      );
    } catch {
      done(false);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done(false);
    }, 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 && out.trim().startsWith('1'));
    });
  });
}

const HIT_ROLES: ReadonlySet<string> = new Set([
  'kick',
  'bass',
  'snare',
  'percussion',
  'melodic',
  'vocal',
  'piano',
  'guitar',
]);
const PITCHED_SIGNAL_ROLES: ReadonlySet<HitRole> = new Set([
  'bass',
  'melodic',
  'piano',
  'guitar',
  'vocal',
]);
const SECTION_CUE_TYPES: ReadonlySet<string> = new Set([
  'build',
  'drop',
  'breakdown',
  'rise',
  'fall',
]);

const SETUP_HINT =
  'Analysis needs the project Python env. Run the setup script ' +
  '(scripts/setup.ps1 on Windows, scripts/setup.sh on macOS/Linux), then set the ' +
  'PYTHON environment variable to the venv Python (for example ' +
  '.venv/Scripts/python.exe or .venv/bin/python).';

const STEMS_SETUP_HINT =
  'Neural per-instrument analysis needs PyTorch + Demucs (plus librosa) in the ' +
  'Python env. Run scripts/setup.ps1 (Windows) or scripts/setup.sh (macOS/Linux), ' +
  'then point PYTHON at that venv.';

interface RawEvent {
  timeSec: number;
  pitchMidi: number;
  velocity: number;
  role?: string;
  confidence?: number;
  salience?: number;
}

interface RawFeatureFrame {
  timeSec: number;
  loudness: number;
  bassEnergy: number;
  brightness: number;
  onsetDensity: number;
  harmonicEnergy: number;
  percussiveEnergy: number;
}

interface RawSectionCue {
  type: string;
  startSec: number;
  endSec: number;
  peakSec?: number;
  intensity: number;
  confidence: number;
}

interface RawExtractionResult {
  version: 1;
  durationSec: number;
  tempo: number;
  mode: AudioAnalysisMode;
  events: RawEvent[];
  featureFrames: RawFeatureFrame[];
  sectionCues: RawSectionCue[];
  roleSignals?: RoleSignals;
}

/**
 * Run the rich librosa analysis and return discrete hits plus scene-level data.
 * This is the preferred API for renderers and analysis UIs.
 */
export async function analyzeAudioEvents(
  audioPath: string,
): Promise<AudioAnalysis> {
  const python = process.env[PYTHON_ENV_VAR] ?? DEFAULT_PYTHON;
  const workDir = await mkdtemp(join(tmpdir(), 'motionscore-analysis-'));
  const outJson = join(workDir, 'analysis.json');

  try {
    await runExtractor(python, audioPath, outJson);
    const rawJson = await readFile(outJson, 'utf8');
    const result = parseExtractionResult(JSON.parse(rawJson) as unknown, audioPath);
    const analysis: AudioAnalysis = {
      version: 1,
      durationSec: result.durationSec,
      tempoBpm: result.tempo,
      mode: result.mode,
      hits: buildNoteEvents(result.events),
      featureFrames: buildFeatureFrames(result.featureFrames),
      sectionCues: buildSectionCues(result.sectionCues),
    };
    if (result.roleSignals !== undefined) analysis.roleSignals = result.roleSignals;
    return analysis;
  } catch (cause) {
    if (cause instanceof TranscriptionError) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new TranscriptionError(
      `Unable to read or validate audio analyzer output for "${audioPath}": ${detail}`,
      { cause },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Backward-compatible Stage B helper returning only the selected NoteEvent[].
 * Use {@link analyzeAudioEvents} when feature frames or section cues are needed.
 */
export async function extractAudioEvents(audioPath: string): Promise<NoteEvent[]> {
  return (await analyzeAudioEvents(audioPath)).hits;
}

function runExtractor(python: string, audioPath: string, outJson: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(python, [STEMS_SCRIPT_PATH, audioPath, outJson, 'stems'], {
      shell: false,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });

    let stderr = '';
    let forwardBuffer = '';
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const clearAnalyzerTimeout = (): void => {
      if (timeout !== undefined) clearTimeout(timeout);
    };
    const rejectOnce = (error: TranscriptionError): void => {
      if (!settled) {
        settled = true;
        clearAnalyzerTimeout();
        reject(error);
      }
    };
    timeout = setTimeout(() => {
      child.kill();
      rejectOnce(
        new TranscriptionError(
          `Audio analysis timed out after ${ANALYZER_TIMEOUT_MS / 60_000} minutes for "${audioPath}".`,
        ),
      );
    }, ANALYZER_TIMEOUT_MS);

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      // Forward the analyzer's own "[motionscore]" progress markers (e.g. the
      // stems separation device line) to this process's stderr so CLI verbose
      // output and the web progress stream surface them live. Line-buffered so a
      // marker split across chunks is not emitted twice or truncated.
      forwardBuffer += text;
      let newlineIndex = forwardBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = forwardBuffer.slice(0, newlineIndex).trimEnd();
        forwardBuffer = forwardBuffer.slice(newlineIndex + 1);
        if (line.includes('[motionscore]')) {
          process.stderr.write(`${line}\n`);
        }
        newlineIndex = forwardBuffer.indexOf('\n');
      }
    });

    child.on('error', (cause: Error) => {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        rejectOnce(
          new TranscriptionError(`Python executable "${python}" was not found. ${SETUP_HINT}`, {
            cause,
          }),
        );
        return;
      }
      rejectOnce(
        new TranscriptionError(
          `Failed to start the audio analysis subprocess ("${python}"): ${cause.message}. ${SETUP_HINT}`,
          { cause },
        ),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearAnalyzerTimeout();
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim();
      const dependencyHint = /ModuleNotFoundError|No module named|ImportError/i.test(detail)
        ? ` ${STEMS_SETUP_HINT}`
        : '';
      reject(
        new TranscriptionError(
          `Audio analysis exited with code ${code ?? 'null'} for "${audioPath}".${dependencyHint}` +
            (detail.length > 0 ? `\n--- analyzer output ---\n${detail}` : ''),
          detail.length > 0 ? { stderr: detail } : undefined,
        ),
      );
    });
  });
}

function parseExtractionResult(
  value: unknown,
  audioPath: string,
): RawExtractionResult {
  const root = requireRecord(value, audioPath, 'root');
  if (root['version'] !== 1) invalidOutput(audioPath, 'version', root['version']);

  const durationSec = requireNumber(root, 'durationSec', audioPath, 0);
  const tempo = requireNumber(root, 'tempo', audioPath, 0);
  const rawMode = root['mode'];
  if (typeof rawMode !== 'string' || !isAnalysisMode(rawMode)) {
    invalidOutput(audioPath, 'mode', rawMode);
  }

  const rawEvents = requireArray(root, 'events', audioPath);
  const events = rawEvents.map((item, index): RawEvent => {
    const path = `events[${index}]`;
    const record = requireRecord(item, audioPath, path);
    const event: RawEvent = {
      timeSec: requireNumber(record, 'timeSec', audioPath, 0, durationSec + 0.1, path),
      pitchMidi: requireNumber(record, 'pitchMidi', audioPath, 0, 127, path),
      velocity: requireNumber(record, 'velocity', audioPath, 0, 1, path),
    };
    const role = record['role'];
    if (role !== undefined) {
      if (typeof role !== 'string' || !HIT_ROLES.has(role)) {
        invalidOutput(audioPath, `${path}.role`, role);
      }
      event.role = role;
    }
    const confidence = optionalUnitNumber(record, 'confidence', audioPath, path);
    if (confidence !== undefined) event.confidence = confidence;
    const salience = optionalUnitNumber(record, 'salience', audioPath, path);
    if (salience !== undefined) event.salience = salience;
    return event;
  });

  const rawFrames = requireArray(root, 'featureFrames', audioPath);
  const featureFrames = rawFrames.map((item, index): RawFeatureFrame => {
    const path = `featureFrames[${index}]`;
    const record = requireRecord(item, audioPath, path);
    return {
      timeSec: requireNumber(record, 'timeSec', audioPath, 0, durationSec + 0.1, path),
      loudness: requireNumber(record, 'loudness', audioPath, 0, 1, path),
      bassEnergy: requireNumber(record, 'bassEnergy', audioPath, 0, 1, path),
      brightness: requireNumber(record, 'brightness', audioPath, 0, 1, path),
      onsetDensity: requireNumber(record, 'onsetDensity', audioPath, 0, 1, path),
      harmonicEnergy: requireNumber(record, 'harmonicEnergy', audioPath, 0, 1, path),
      percussiveEnergy: requireNumber(record, 'percussiveEnergy', audioPath, 0, 1, path),
    };
  });

  const rawCues = requireArray(root, 'sectionCues', audioPath);
  const sectionCues = rawCues.map((item, index): RawSectionCue => {
    const path = `sectionCues[${index}]`;
    const record = requireRecord(item, audioPath, path);
    const type = record['type'];
    if (typeof type !== 'string' || !SECTION_CUE_TYPES.has(type)) {
      invalidOutput(audioPath, `${path}.type`, type);
    }
    const startSec = requireNumber(record, 'startSec', audioPath, 0, durationSec + 0.1, path);
    const endSec = requireNumber(record, 'endSec', audioPath, startSec, durationSec + 0.1, path);
    const cue: RawSectionCue = {
      type,
      startSec,
      endSec,
      intensity: requireNumber(record, 'intensity', audioPath, 0, 1, path),
      confidence: requireNumber(record, 'confidence', audioPath, 0, 1, path),
    };
    const peakSec = record['peakSec'];
    if (peakSec !== undefined) {
      if (typeof peakSec !== 'number' || !Number.isFinite(peakSec) || peakSec < 0 || peakSec > durationSec + 0.1) {
        invalidOutput(audioPath, `${path}.peakSec`, peakSec);
      }
      cue.peakSec = peakSec;
    }
    return cue;
  });

  const roleSignals = parseRoleSignals(
    root['roleSignals'],
    audioPath,
    featureFrames.length,
  );
  const result: RawExtractionResult = {
    version: 1,
    durationSec,
    tempo,
    mode: rawMode,
    events,
    featureFrames,
    sectionCues,
  };
  if (roleSignals !== undefined) result.roleSignals = roleSignals;
  return result;
}

function parseRoleSignals(
  value: unknown,
  audioPath: string,
  expectedFrameCount: number,
): RoleSignals | undefined {
  if (value === undefined) return undefined;
  const root = requireRecord(value, audioPath, 'roleSignals');
  if (root['version'] !== 1) invalidOutput(audioPath, 'roleSignals.version', root['version']);
  const frameRateHz = requireNumber(root, 'frameRateHz', audioPath, 10, 10, 'roleSignals');
  const frameCount = requireInteger(root, 'frameCount', audioPath, 0, 'roleSignals');
  if (frameCount !== expectedFrameCount) {
    invalidOutput(audioPath, 'roleSignals.frameCount', frameCount);
  }

  const rawTracks = requireArray(root, 'tracks', audioPath);
  if (rawTracks.length !== ROLE_ORDER.length) {
    invalidOutput(audioPath, 'roleSignals.tracks.length', rawTracks.length);
  }
  const tracks = rawTracks.map((item, index): RoleSignalTrack => {
    const path = `roleSignals.tracks[${index}]`;
    const record = requireRecord(item, audioPath, path);
    const expectedRole = ROLE_ORDER[index]!;
    if (record['role'] !== expectedRole) {
      invalidOutput(audioPath, `${path}.role`, record['role']);
    }
    const activityQ8 = requireBoundedIntegerArray(
      record,
      'activityQ8',
      audioPath,
      path,
      frameCount,
      0,
      255,
    );
    const rawSpans = requireArray(record, 'sustainSpans', audioPath);
    let previousEnd = -1;
    const sustainSpans = rawSpans.map((spanValue, spanIndex): SustainSpan => {
      const spanPath = `${path}.sustainSpans[${spanIndex}]`;
      if (!Array.isArray(spanValue) || spanValue.length !== 2) {
        invalidOutput(audioPath, spanPath, spanValue);
      }
      const start = spanValue[0];
      const end = spanValue[1];
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        (start as number) < 0 ||
        (end as number) <= (start as number) ||
        (end as number) > frameCount ||
        (start as number) <= previousEnd
      ) {
        invalidOutput(audioPath, spanPath, spanValue);
      }
      previousEnd = end as number;
      return [start as number, end as number];
    });

    const track: RoleSignalTrack = {
      role: expectedRole,
      activityQ8,
      sustainSpans,
    };
    const rawDirection = record['pitchDirection'];
    if (rawDirection !== undefined) {
      if (!PITCHED_SIGNAL_ROLES.has(expectedRole)) {
        invalidOutput(audioPath, `${path}.pitchDirection`, rawDirection);
      }
      const directions = requireBoundedIntegerArray(
        record,
        'pitchDirection',
        audioPath,
        path,
        frameCount,
        -1,
        1,
      );
      if (directions.some((direction) => direction !== -1 && direction !== 0 && direction !== 1)) {
        invalidOutput(audioPath, `${path}.pitchDirection`, rawDirection);
      }
      track.pitchDirection = directions as PitchDirection[];
    }
    const rawCoverage = record['pitchCoverageQ8'];
    if (rawCoverage !== undefined) {
      if (!PITCHED_SIGNAL_ROLES.has(expectedRole)) {
        invalidOutput(audioPath, `${path}.pitchCoverageQ8`, rawCoverage);
      }
      track.pitchCoverageQ8 = requireInteger(
        record,
        'pitchCoverageQ8',
        audioPath,
        0,
        path,
        255,
      );
    }
    return track;
  });

  return { version: 1, frameRateHz, frameCount, tracks };
}

function requireInteger(
  record: Record<string, unknown>,
  key: string,
  audioPath: string,
  minimum: number,
  parentPath: string,
  maximum = Number.POSITIVE_INFINITY,
): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalidOutput(audioPath, `${parentPath}.${key}`, value);
  }
  return value as number;
}

function requireBoundedIntegerArray(
  record: Record<string, unknown>,
  key: string,
  audioPath: string,
  parentPath: string,
  expectedLength: number,
  minimum: number,
  maximum: number,
): number[] {
  const values = requireArray(record, key, audioPath);
  if (
    values.length !== expectedLength ||
    values.some(
      (value) => !Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum,
    )
  ) {
    invalidOutput(audioPath, `${parentPath}.${key}`, values);
  }
  return values as number[];
}

function requireRecord(
  value: unknown,
  audioPath: string,
  path: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalidOutput(audioPath, path, value);
  }
  return value as Record<string, unknown>;
}

function requireArray(
  record: Record<string, unknown>,
  key: string,
  audioPath: string,
): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) invalidOutput(audioPath, key, value);
  return value;
}

function requireNumber(
  record: Record<string, unknown>,
  key: string,
  audioPath: string,
  minimum: number,
  maximum = Number.POSITIVE_INFINITY,
  parentPath = '',
): number {
  const value = record[key];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalidOutput(audioPath, parentPath.length > 0 ? `${parentPath}.${key}` : key, value);
  }
  return value;
}

function optionalUnitNumber(
  record: Record<string, unknown>,
  key: string,
  audioPath: string,
  parentPath: string,
): number | undefined {
  if (record[key] === undefined) return undefined;
  return requireNumber(record, key, audioPath, 0, 1, parentPath);
}

function invalidOutput(audioPath: string, path: string, value: unknown): never {
  let rendered: string;
  try {
    rendered = JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  if (rendered.length > 160) rendered = `${rendered.slice(0, 157)}...`;
  throw new TranscriptionError(
    `Audio analyzer returned an invalid version-1 payload for "${audioPath}" at ${path}: ${rendered}.`,
  );
}

/**
 * Normalize raw analyzer events without renderer-side thinning. The Python
 * analyzer owns onset resolution; every returned timestamp becomes one note.
 */
function buildNoteEvents(rawEvents: readonly RawEvent[]): NoteEvent[] {
  const sorted = rawEvents
    .filter((event) => Number.isFinite(event.timeSec) && event.timeSec >= 0)
    .slice()
    .sort((a, b) => a.timeSec - b.timeSec);

  return sorted.map((event, index) => {
    const note: NoteEvent = {
      id: `n${String(index + 1).padStart(NOTE_ID_DIGITS, '0')}`,
      pitchMidi: clampPitch(event.pitchMidi),
      startSec: event.timeSec,
      endSec: event.timeSec + EVENT_DURATION_SEC,
      velocity: clamp01(event.velocity, 0.6),
      source: 'audio',
    };
    if (event.role !== undefined && HIT_ROLES.has(event.role)) {
      const role = event.role as HitRole;
      note.role = role;
      note.track = role;
      note.instrument = role;
    }
    if (event.confidence !== undefined) {
      note.confidence = clamp01(event.confidence, 0.5);
    }
    if (event.salience !== undefined) {
      note.salience = clamp01(event.salience, note.velocity);
    }
    return note;
  });
}

function buildFeatureFrames(rawFrames: readonly RawFeatureFrame[]): AudioFeatureFrame[] {
  return rawFrames
    .filter((frame) => Number.isFinite(frame.timeSec) && frame.timeSec >= 0)
    .map((frame) => ({
      timeSec: nonNegative(frame.timeSec),
      loudness: clamp01(frame.loudness),
      bassEnergy: clamp01(frame.bassEnergy),
      brightness: clamp01(frame.brightness),
      onsetDensity: clamp01(frame.onsetDensity),
      harmonicEnergy: clamp01(frame.harmonicEnergy),
      percussiveEnergy: clamp01(frame.percussiveEnergy),
    }))
    .sort((a, b) => a.timeSec - b.timeSec);
}

function buildSectionCues(rawCues: readonly RawSectionCue[]): SectionCue[] {
  const cues: SectionCue[] = [];
  for (const raw of rawCues) {
    if (
      !SECTION_CUE_TYPES.has(raw.type) ||
      !Number.isFinite(raw.startSec) ||
      !Number.isFinite(raw.endSec) ||
      raw.startSec < 0 ||
      raw.endSec < raw.startSec
    ) {
      continue;
    }
    const cue: SectionCue = {
      type: raw.type as SectionCue['type'],
      startSec: raw.startSec,
      endSec: raw.endSec,
      intensity: clamp01(raw.intensity),
      confidence: clamp01(raw.confidence),
    };
    if (raw.peakSec !== undefined && Number.isFinite(raw.peakSec) && raw.peakSec >= 0) {
      cue.peakSec = raw.peakSec;
    }
    cues.push(cue);
  }
  return cues.sort((a, b) => a.startSec - b.startSec || a.type.localeCompare(b.type));
}

function isAnalysisMode(value: string): value is AudioAnalysisMode {
  return value === 'stems';
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return 60;
  return Math.max(21, Math.min(108, Math.round(pitch)));
}

function clamp01(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}
