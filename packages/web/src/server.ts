// MotionScore web server.
//
// Uploads an audio file, runs neural per-instrument analysis (Demucs stems) via
// @motionscore/note-extractor, and streams the resulting AudioAnalysis to the
// browser, which draws the live 2D scene. There is no baked video: the browser
// plays the original audio (/api/audio) as the clock.
//
// Endpoints:
//   POST /api/generate      — upload audio, returns { jobId }
//   GET  /api/progress/:id  — SSE stream of analysis progress
//   GET  /api/result/:id    — { durationSec, audioUrl, analysis } (full AudioAnalysis)
//   GET  /api/audio/:id     — stream the original audio for in-browser playback

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import express, { type Request, type Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import { nanoid } from 'nanoid';

import {
  analyzeAudio,
  summarizeAnalysis,
  detectStemsGpuAvailable,
  AUDIO_EXTENSIONS,
} from '@motionscore/note-extractor';
import type { AudioAnalysis, AudioAnalysisSummary } from '@motionscore/types';

// ---------------------------------------------------------------------------
// Resolve the venv Python used for neural stems analysis (PyTorch + Demucs).
// ---------------------------------------------------------------------------
// If PYTHON is unset (or points at a missing venv), fall back to the project's
// .venv so the server "just works" after running the setup script.

const __serverDir = fileURLToPath(new URL('.', import.meta.url));
// Project root is three levels up from packages/web/src/ (or packages/web/dist/).
const PROJECT_ROOT = resolve(__serverDir, '..', '..', '..');

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
      resolvedPython = configured; // bare command like "python3" -> trust PATH
    } else {
      const abs = isAbsolute(configured) ? configured : resolve(PROJECT_ROOT, configured);
      resolvedPython = existsSync(abs) ? abs : detectVenv() ?? abs;
    }
  } else {
    resolvedPython = detectVenv();
  }

  if (resolvedPython) process.env.PYTHON = resolvedPython;
  console.log(
    `[motionscore-web] Python for stems analysis: ${
      process.env.PYTHON ?? '(none found — run the setup script and set PYTHON)'
    }`,
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProgressEvent {
  message: string;
  percent?: number;
  status?: 'complete' | 'error';
  analysis?: AudioAnalysisSummary;
  /** URL for the full AudioAnalysis JSON (the live scene fetches this). */
  resultUrl?: string;
  /** URL streaming the original audio for in-browser playback. */
  audioUrl?: string;
}

interface Job {
  id: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  inputPath: string;
  /** Original file extension (with dot), used to set the audio Content-Type. */
  inputExt: string;
  /** Directory the analyzer writes per-stem audio (+ stems.json) into. */
  stemsDir: string;
  /** Playable separated stems (set on completion): name -> on-disk mp3 path. */
  stems: Array<{ name: string; file: string }>;
  /** Full rich audio analysis (set on completion). */
  analysis?: AudioAnalysis;
  progress: ProgressEvent[];
  error?: string;
  createdAt: number;
  listeners: Set<Response>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '3001', 10);
const CLEANUP_TTL_MS = parseInt(process.env.CLEANUP_TTL_MS ?? String(30 * 60 * 1000), 10);
const UPLOAD_DIR = join(tmpdir(), 'motionscore-uploads');
const STEMS_DIR = join(tmpdir(), 'motionscore-stems');
const AUDIO_CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
};

/** Friendly display labels for the playable Demucs stems. */
const STEM_LABELS: Record<string, string> = {
  drums: 'Drums',
  bass: 'Bass',
  vocals: 'Vocals',
  guitar: 'Guitar',
  piano: 'Piano',
  other: 'Other / Melody',
};

mkdirSync(UPLOAD_DIR, { recursive: true });
mkdirSync(STEMS_DIR, { recursive: true });

/** Read the analyzer's stems.json manifest into absolute on-disk stem paths. */
function readStemManifest(stemsDir: string): Array<{ name: string; file: string }> {
  const manifestPath = join(stemsDir, 'stems.json');
  if (!existsSync(manifestPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    const stems: Array<{ name: string; file: string }> = [];
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as any).name === 'string' &&
        typeof (entry as any).file === 'string'
      ) {
        const name = (entry as any).name as string;
        // Guard against path traversal from the manifest filename.
        const safe = name.replace(/[^a-z0-9_-]/gi, '');
        const file = join(stemsDir, `${safe}.mp3`);
        if (safe && existsSync(file)) stems.push({ name: safe, file });
      }
    }
    return stems;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------

const jobs = new Map<string, Job>();

function emitToJob(job: Job, event: ProgressEvent): void {
  job.progress.push(event);
  const data = JSON.stringify(event);
  for (const res of job.listeners) res.write(`data: ${data}\n\n`);
}

function scheduleCleanup(job: Job): void {
  setTimeout(() => {
    try {
      if (existsSync(job.inputPath)) rmSync(job.inputPath, { force: true });
    } catch {
      /* ignore cleanup errors */
    }
    try {
      if (existsSync(job.stemsDir)) rmSync(job.stemsDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
    jobs.delete(job.id);
  }, CLEANUP_TTL_MS);
}

/**
 * Forward the analyzer's `[motionscore]` stderr lines to the job as coarse
 * progress while `analyzeAudio` runs (Demucs emits a "separating on <device>"
 * line). Restores the original stderr writer when done.
 */
async function analyzeWithProgress(job: Job): Promise<AudioAnalysis> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('[motionscore]') || str.includes('separating')) {
      emitToJob(job, { message: str.trim().replace(/^\[motionscore\]\s*/, ''), percent: 45 });
    }
    return (originalWrite as any)(chunk, ...args);
  }) as typeof process.stderr.write;
  try {
    return await analyzeAudio(job.inputPath, { stemsDir: job.stemsDir });
  } finally {
    process.stderr.write = originalWrite;
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0];
    if (ext && AUDIO_EXTENSIONS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type. Accepted: ${[...AUDIO_EXTENSIONS].join(', ')}`));
    }
  },
});

// POST /api/generate — upload an audio file and start analysis.
app.post('/api/generate', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const jobId = nanoid(12);
  const originalExt = req.file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '.mp3';
  const inputPath = `${req.file.path}${originalExt}`;
  renameSync(req.file.path, inputPath);

  const job: Job = {
    id: jobId,
    status: 'pending',
    inputPath,
    inputExt: originalExt,
    stemsDir: join(STEMS_DIR, jobId),
    stems: [],
    progress: [],
    createdAt: Date.now(),
    listeners: new Set(),
  };
  jobs.set(jobId, job);

  res.json({ jobId, progressUrl: `/api/progress/${jobId}` });

  setImmediate(async () => {
    job.status = 'running';
    emitToJob(job, { message: 'Uploaded — preparing neural analysis', percent: 5 });

    try {
      const hasGpu = await detectStemsGpuAvailable();
      emitToJob(job, {
        message: hasGpu
          ? 'GPU detected — separating instruments (neural)'
          : 'No GPU detected — separating on CPU (this can take a while)',
        percent: 12,
      });

      const analysis = await analyzeWithProgress(job);
      job.analysis = analysis;
      job.stems = readStemManifest(job.stemsDir);
      job.status = 'complete';
      emitToJob(job, {
        status: 'complete',
        message: 'Analysis complete',
        percent: 100,
        analysis: summarizeAnalysis(analysis),
        resultUrl: `/api/result/${jobId}`,
        audioUrl: `/api/audio/${jobId}`,
      });
    } catch (err: any) {
      job.status = 'error';
      job.error = err?.message ?? 'Analysis failed';
      emitToJob(job, { status: 'error', message: job.error! });
    }

    scheduleCleanup(job);
  });
});

// GET /api/progress/:jobId — SSE stream.
app.get('/api/progress/:jobId', (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  for (const event of job.progress) res.write(`data: ${JSON.stringify(event)}\n\n`);

  if (job.status === 'complete' || job.status === 'error') {
    res.end();
    return;
  }

  job.listeners.add(res);
  req.on('close', () => {
    job.listeners.delete(res);
  });
});

// GET /api/result/:jobId — full AudioAnalysis for the live scene.
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
    durationSec: job.analysis?.durationSec ?? 0,
    audioUrl: `/api/audio/${jobId}`,
    analysis: job.analysis ?? null,
    // Playable separated stems for the in-browser mixer (mute/solo). Only whole
    // Demucs stems are separable; kick/snare/perc share the one drums stem.
    stems: job.stems.map((s) => ({
      id: s.name,
      label: STEM_LABELS[s.name] ?? s.name,
      url: `/api/stem/${jobId}/${s.name}`,
    })),
  });
});

// GET /api/stem/:jobId/:name — stream one separated stem (mp3) for the mixer.
app.get('/api/stem/:jobId/:name', (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const rawName = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  const stem = job.stems.find((s) => s.name === rawName);
  if (!stem || !existsSync(stem.file)) {
    res.status(404).json({ error: 'Stem not found' });
    return;
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.sendFile(stem.file);
});

// GET /api/audio/:jobId — stream the original uploaded audio (range-capable via
// sendFile) so the browser <audio> element can play and seek it.
app.get('/api/audio/:jobId', (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return;
  }
  if (!existsSync(job.inputPath)) {
    res.status(410).json({ error: 'Audio has been cleaned up' });
    return;
  }
  res.setHeader('Content-Type', AUDIO_CONTENT_TYPES[job.inputExt] ?? 'application/octet-stream');
  res.sendFile(job.inputPath);
});

// ---------------------------------------------------------------------------
// Serve the built client in production
// ---------------------------------------------------------------------------

const clientDistDir = join(__serverDir, 'client');
if (existsSync(clientDistDir)) {
  app.use(express.static(clientDistDir));
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
