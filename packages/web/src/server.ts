// @motionscore/web — Express backend exposing the MotionScore pipeline as HTTP API.
//
// Endpoints:
//   POST /api/generate       — upload file + options, returns jobId
//   GET  /api/progress/:id   — SSE stream of pipeline progress
//   GET  /api/video/:id      — serve the generated MP4
//   GET  /api/video/:id/download — serve with Content-Disposition attachment

import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import express, { type Request, type Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import { nanoid } from 'nanoid';

import type { ParsedArgs } from '@motionscore/cli';
import type {
  AudioAnalysisSummary,
  AudioAnalysis,
  Choreography,
  CLIOptions,
} from '@motionscore/types';

// ---------------------------------------------------------------------------
// Auto-detect venv Python for Basic Pitch transcription
// ---------------------------------------------------------------------------
// If PYTHON is not already set, look for the project's .venv and use it.
// This means the server "just works" for audio input after running the setup
// script — no manual env var needed.

const __filename = fileURLToPath(import.meta.url);
const __serverDir = fileURLToPath(new URL('.', import.meta.url));
// Project root is three levels up from packages/web/src/ (or packages/web/dist/)
const PROJECT_ROOT = resolve(__serverDir, '..', '..', '..');

// Resolve the Python executable used for audio analysis (librosa / Basic Pitch /
// Demucs). The server must "just work" after a setup script and tolerate a
// PYTHON value that is relative (e.g. ".\.venv\Scripts\python.exe") or points at
// a venv that no longer exists — the server's cwd is not guaranteed to be the
// project root, so a relative path would otherwise fail to spawn.
{
  const venvCandidates = [
    join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe'), // Windows
    join(PROJECT_ROOT, '.venv', 'bin', 'python'), // POSIX
  ];
  const detectVenv = (): string | undefined => venvCandidates.find((p) => existsSync(p));

  const configured = process.env.PYTHON?.trim();
  let resolvedPython: string | undefined;

  if (configured) {
    const looksLikePath = configured.includes('/') || configured.includes('\\');
    if (!looksLikePath) {
      // Bare command such as "python" / "python3": trust PATH resolution as-is.
      resolvedPython = configured;
    } else {
      // Make a relative path absolute against the project root, then verify it.
      const abs = isAbsolute(configured) ? configured : resolve(PROJECT_ROOT, configured);
      if (existsSync(abs)) {
        resolvedPython = abs;
      } else {
        const fallback = detectVenv();
        if (fallback) {
          console.warn(
            `[motionscore-web] PYTHON="${configured}" was not found (resolved to ${abs}); ` +
              `using detected venv Python instead: ${fallback}`,
          );
          resolvedPython = fallback;
        } else {
          // Keep the absolute form so the downstream error names a real path and
          // the setup hint still guides the user.
          resolvedPython = abs;
        }
      }
    }
  } else {
    resolvedPython = detectVenv();
  }

  if (resolvedPython) {
    process.env.PYTHON = resolvedPython;
  }
  console.log(
    `[motionscore-web] Python for audio analysis: ${
      process.env.PYTHON ?? '(none set — run scripts/setup-audio and set PYTHON)'
    }`,
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  inputPath: string;
  outputPath: string;
  /** 'audio' | 'midi' — only audio has a playable track to stream to the browser. */
  inputType?: 'midi' | 'audio';
  /** Original file extension (with dot), used to set the audio Content-Type. */
  inputExt?: string;
  /** Full choreography for the real-time renderer (set on completion). */
  choreography?: Choreography;
  /** Full rich audio analysis for the real-time renderer (audio only). */
  analysisFull?: AudioAnalysis;
  progress: ProgressEvent[];
  stats?: {
    totalNotes: number;
    renderedFrames: number;
    durationSec: number;
    maxSyncErrorMs: number;
  };
  error?: string;
  createdAt: number;
  listeners: Set<Response>;
}

interface ProgressEvent {
  stage?: string;
  message: string;
  percent?: number;
  status?: 'complete' | 'error';
  stats?: Job['stats'];
  analysis?: AudioAnalysisSummary;
  videoUrl?: string;
  /** URL for the full choreography + analysis JSON (real-time renderer). */
  resultUrl?: string;
  /** URL to stream the original audio for in-browser playback (audio only). */
  audioUrl?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const CLEANUP_TTL_MS = parseInt(process.env.CLEANUP_TTL_MS ?? String(30 * 60 * 1000), 10);
const UPLOAD_DIR = join(tmpdir(), 'motionscore-uploads');
const OUTPUT_DIR = join(tmpdir(), 'motionscore-outputs');

// Ensure directories exist
mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(OUTPUT_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------

const jobs = new Map<string, Job>();

// ---------------------------------------------------------------------------
// Stage-to-percent mapping
// ---------------------------------------------------------------------------

// Percent shown when each verbose stage STARTS. Keys must match the exact
// stage names emitted by the CLI pipeline's verbose logs (see pipeline.ts).
const STAGE_PERCENT: Record<string, number> = {
  'check input readable': 3,
  'extract notes (Stage B)': 8,
  'map notes (Stage C)': 22,
  'solve trajectory (Stage D)': 30,
  'check ffmpeg available': 36,
  'render + encode (Stage E+F)': 42,
};

/** The single streaming stage that dominates wall-clock time. */
const RENDER_STAGE = 'render + encode (Stage E+F)';
const RENDER_START_PERCENT = 42;
const RENDER_END_PERCENT = 98;

function estimatePercent(stageName: string, done: boolean): number {
  const base = STAGE_PERCENT[stageName];
  if (base === undefined) return 0;
  if (done) {
    // The render+encode stage is last; keep the bar near the top when it
    // finishes rather than snapping back to its start percent.
    if (stageName === RENDER_STAGE) return RENDER_END_PERCENT;
    const stages = Object.keys(STAGE_PERCENT);
    const idx = stages.indexOf(stageName);
    if (idx >= 0 && idx < stages.length - 1) {
      return STAGE_PERCENT[stages[idx + 1]] ?? base;
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Progress capture
// ---------------------------------------------------------------------------

/** runPipeline's result type, referenced without eagerly loading the CLI module. */
type PipelineResult = Awaited<ReturnType<(typeof import('@motionscore/cli'))['runPipeline']>>;

async function runWithProgressCapture(
  parsed: ParsedArgs,
  onProgress: (line: string) => void,
): Promise<PipelineResult> {
  // Lazy-load the heavy pipeline (pulls in the renderer + native canvas) only
  // when a job actually runs, so the server binds its port instantly at boot.
  const { runPipeline } = await import('@motionscore/cli');
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('[motionscore]')) {
      onProgress(str.trim());
    }
    return originalWrite(chunk, ...args);
  }) as typeof process.stderr.write;

  try {
    return await runPipeline(parsed);
  } finally {
    process.stderr.write = originalWrite;
  }
}

function parseProgressLine(line: string): ProgressEvent {
  // Pattern: [motionscore] <stage>...
  const startMatch = line.match(/\[motionscore\] (.+)\.\.\.$/);
  if (startMatch) {
    const stage = startMatch[1];
    return {
      stage,
      message: `${stage} started`,
      percent: estimatePercent(stage, false),
    };
  }

  // Pattern: [motionscore] <stage> done in <time>ms (<detail>)
  const doneMatch = line.match(/\[motionscore\] (.+?) done in ([\d.]+)ms(?: \((.+)\))?$/);
  if (doneMatch) {
    const stage = doneMatch[1];
    const detail = doneMatch[3] ?? '';
    return {
      stage,
      message: `${stage} completed${detail ? ` (${detail})` : ''}`,
      percent: estimatePercent(stage, true),
    };
  }

  // Pattern: [motionscore] validated ...
  const validateMatch = line.match(/\[motionscore\] (validated .+)$/);
  if (validateMatch) {
    return { message: validateMatch[1] };
  }

  // Pattern: [motionscore] render+encode progress: N/M frames
  const renderMatch = line.match(/\[motionscore\] render\+encode progress: (\d+)\/(\d+) frames$/);
  if (renderMatch) {
    const rendered = parseInt(renderMatch[1]!, 10);
    const total = parseInt(renderMatch[2]!, 10);
    const fraction = total > 0 ? Math.min(1, rendered / total) : 0;
    const percent = Math.round(
      RENDER_START_PERCENT + fraction * (RENDER_END_PERCENT - RENDER_START_PERCENT),
    );
    return {
      stage: RENDER_STAGE,
      message: `Rendering: ${rendered}/${total} frames`,
      percent,
    };
  }

  // Fallback
  return { message: line.replace('[motionscore] ', '') };
}

function emitToJob(job: Job, event: ProgressEvent): void {
  job.progress.push(event);
  const data = JSON.stringify(event);
  for (const res of job.listeners) {
    res.write(`data: ${data}\n\n`);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

function scheduleCleanup(job: Job): void {
  setTimeout(() => {
    try {
      if (existsSync(job.inputPath)) rmSync(job.inputPath, { force: true });
      if (existsSync(job.outputPath)) rmSync(job.outputPath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
    jobs.delete(job.id);
  }, CLEANUP_TTL_MS);
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

// Multer config for file uploads
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.mid', '.midi', '.wav', '.mp3', '.flac', '.ogg'];
    const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (ext && allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type. Accepted: ${allowed.join(', ')}`));
    }
  },
});

// GET /api/encoders — list available H.264 encoders (for the frontend dropdown)
app.get('/api/encoders', async (_req: Request, res: Response) => {
  const { detectAvailableEncoders } = await import('@motionscore/video-export');
  const encoders = await detectAvailableEncoders();
  const descriptions: Record<string, string> = {
    'libx264': 'CPU (libx264)',
    'h264_nvenc': 'NVIDIA GPU (NVENC)',
    'h264_amf': 'AMD GPU (AMF)',
    'h264_qsv': 'Intel GPU (Quick Sync)',
  };
  res.json(encoders.map((enc) => ({ id: enc, label: descriptions[enc] ?? enc })));
});

// POST /api/generate — start a new generation job
app.post('/api/generate', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const jobId = nanoid(12);
  const originalExt = req.file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '.mid';
  const inputPath = `${req.file.path}${originalExt}`;

  // Rename uploaded file to include original extension (multer strips it)
  const { renameSync } = await import('node:fs');
  renameSync(req.file.path, inputPath);

  const outputPath = join(OUTPUT_DIR, `${jobId}.mp4`);

  // Parse options from form data
  const fps = req.body.fps ? parseInt(req.body.fps, 10) : 60;
  const width = req.body.width ? parseInt(req.body.width, 10) : 1920;
  const height = req.body.height ? parseInt(req.body.height, 10) : 1080;
  const layout = req.body.layout === 'lanes' ? 'lanes' : 'piano-keys';
  const ALLOWED_MODES = ['auto', 'beats', 'onsets', 'stems', 'notes'];
  const mode = ALLOWED_MODES.includes(req.body.mode) ? req.body.mode : 'auto';
  const ALLOWED_BALLS = ['single', 'per-role'];
  const balls = ALLOWED_BALLS.includes(req.body.balls) ? req.body.balls : 'single';
  const codec = req.body.codec || undefined;
  const gpuDevice = req.body.gpuDevice !== undefined ? parseInt(req.body.gpuDevice, 10) : undefined;
  const preset = req.body.preset || undefined;
  const parallelFrames = req.body.parallelFrames ? parseInt(req.body.parallelFrames, 10) : 4;

  const job: Job = {
    id: jobId,
    status: 'pending',
    inputPath,
    outputPath,
    inputExt: originalExt,
    progress: [],
    createdAt: Date.now(),
    listeners: new Set(),
  };
  jobs.set(jobId, job);

  // Return job ID immediately
  res.json({ jobId, progressUrl: `/api/progress/${jobId}` });

  // Run pipeline in background
  setImmediate(async () => {
    job.status = 'running';

    let inputType: 'midi' | 'audio';
    try {
      const { detectInputType } = await import('@motionscore/cli');
      inputType = detectInputType(inputPath);
    } catch (err: any) {
      job.status = 'error';
      job.error = err.message ?? 'Failed to detect input type';
      emitToJob(job, { status: 'error', message: job.error! });
      scheduleCleanup(job);
      return;
    }

    job.inputType = inputType;

    // Auto-prefer neural stems for audio when a GPU is available: real
    // per-instrument roles make far more of the music visible than the librosa
    // heuristic. Falls back to the heuristic (auto->smart) on CPU-only or if the
    // probe fails, so nobody waits minutes for a slow CPU separation.
    let effectiveMode = mode;
    if (inputType === 'audio' && mode === 'auto') {
      try {
        const { detectStemsGpuAvailable } = await import('@motionscore/cli');
        if (await detectStemsGpuAvailable()) {
          effectiveMode = 'stems';
          emitToJob(job, {
            message: 'GPU detected — using neural per-instrument separation (stems)',
            percent: 6,
          });
        }
      } catch {
        /* keep auto/smart on any probe failure */
      }
    }

    const options: CLIOptions = {
      input: inputPath,
      output: outputPath,
      mode: effectiveMode,
      balls,
      fps,
      width,
      height,
      layout,
      verbose: true, // Always verbose so we capture progress
      codec,
      gpuDevice,
      preset,
      parallelFrames,
      // Audio inputs power the real-time 2D renderer, which needs only the
      // analysis + choreography + original audio — so skip the slow MP4 render
      // (the browser plays /api/audio directly). MIDI has no playable audio, so
      // it still renders a video-only MP4.
      skipRender: inputType === 'audio',
    };

    const parsed: ParsedArgs = { options, inputType };

    try {
      const result = await runWithProgressCapture(parsed, (line) => {
        const event = parseProgressLine(line);
        emitToJob(job, event);
      });

      job.status = 'complete';
      job.stats = result.stats;
      job.choreography = result.choreography;
      job.analysisFull = result.audioAnalysis;
      const hasVideo = job.inputType !== 'audio';
      emitToJob(job, {
        status: 'complete',
        stats: result.stats,
        analysis: result.analysis,
        videoUrl: hasVideo ? `/api/video/${jobId}` : undefined,
        resultUrl: `/api/result/${jobId}`,
        audioUrl: job.inputType === 'audio' ? `/api/audio/${jobId}` : undefined,
        message: 'Pipeline complete',
        percent: 100,
      });
    } catch (err: any) {
      job.status = 'error';
      job.error = err.message ?? 'Pipeline failed';
      emitToJob(job, { status: 'error', message: job.error! });
    }

    scheduleCleanup(job);
  });
});

// GET /api/progress/:jobId — SSE endpoint
app.get('/api/progress/:jobId', (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send already-emitted progress events
  for (const event of job.progress) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // If job is already done, close
  if (job.status === 'complete' || job.status === 'error') {
    res.end();
    return;
  }

  // Otherwise register as listener
  job.listeners.add(res);
  req.on('close', () => {
    job.listeners.delete(res);
  });
});

// GET /api/video/:jobId — serve generated MP4
app.get('/api/video/:jobId', (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (job.status !== 'complete') {
    res.status(409).json({ error: 'Video not ready yet', status: job.status });
    return;
  }
  if (!existsSync(job.outputPath)) {
    res.status(410).json({ error: 'Video has been cleaned up' });
    return;
  }

  const stat = statSync(job.outputPath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);
  res.sendFile(job.outputPath);
});

// GET /api/video/:jobId/download — serve with attachment header
app.get('/api/video/:jobId/download', (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (job.status !== 'complete') {
    res.status(409).json({ error: 'Video not ready yet', status: job.status });
    return;
  }
  if (!existsSync(job.outputPath)) {
    res.status(410).json({ error: 'Video has been cleaned up' });
    return;
  }

  res.setHeader('Content-Disposition', `attachment; filename="motionscore-${job.id}.mp4"`);
  res.sendFile(job.outputPath);
});

// GET /api/result/:jobId — full choreography + rich analysis JSON for the
// real-time (Three.js) renderer. Kept separate from the SSE progress frame so
// large trajectory/analysis payloads don't bloat the event stream.
app.get('/api/result/:jobId', (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (job.status !== 'complete') {
    res.status(409).json({ error: 'Result not ready yet', status: job.status });
    return;
  }
  res.json({
    durationSec: job.stats?.durationSec ?? job.choreography?.durationSec ?? 0,
    inputType: job.inputType ?? 'audio',
    hasAudio: job.inputType === 'audio',
    audioUrl: job.inputType === 'audio' ? `/api/audio/${jobId}` : null,
    videoUrl: job.inputType === 'audio' ? null : `/api/video/${jobId}`,
    choreography: job.choreography ?? null,
    analysis: job.analysisFull ?? null,
  });
});

// GET /api/audio/:jobId — stream the ORIGINAL uploaded audio so the browser can
// play it in sync with the real-time renderer. Only audio inputs have a
// playable track (MIDI is video-only). res.sendFile supports Range requests, so
// the <audio> element can seek.
const AUDIO_CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
};
app.get('/api/audio/:jobId', (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (job.inputType !== 'audio') {
    res.status(404).json({ error: 'No playable audio for this input' });
    return;
  }
  if (!existsSync(job.inputPath)) {
    res.status(410).json({ error: 'Audio has been cleaned up' });
    return;
  }
  const ext = job.inputExt ?? '.mp3';
  res.setHeader('Content-Type', AUDIO_CONTENT_TYPES[ext] ?? 'application/octet-stream');
  res.sendFile(job.inputPath);
});

// ---------------------------------------------------------------------------
// Serve static frontend in production
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const clientDistDir = join(__dirname, 'client');

if (existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(join(clientDistDir, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`[motionscore-web] listening on http://localhost:${PORT}`);
});

export { app, server };
