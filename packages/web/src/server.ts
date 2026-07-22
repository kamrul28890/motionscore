// @motionscore/web — Express backend exposing the MotionScore pipeline as HTTP API.
//
// Endpoints:
//   POST /api/generate       — upload file + options, returns jobId
//   GET  /api/progress/:id   — SSE stream of pipeline progress
//   GET  /api/video/:id      — serve the generated MP4
//   GET  /api/video/:id/download — serve with Content-Disposition attachment

import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import express, { type Request, type Response } from 'express';
import multer from 'multer';
import cors from 'cors';
import { nanoid } from 'nanoid';

import { runPipeline, detectInputType, type ParsedArgs } from '@motionscore/cli';
import type { CLIOptions } from '@motionscore/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  inputPath: string;
  outputPath: string;
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
  videoUrl?: string;
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

const STAGE_PERCENT: Record<string, number> = {
  'check input readable': 5,
  'extract notes (Stage B)': 10,
  'map notes (Stage C)': 20,
  'solve trajectory (Stage D)': 30,
  'check ffmpeg available': 35,
  'render frames (Stage E)': 40,
  'export video (Stage F)': 85,
};

function estimatePercent(stageName: string, done: boolean): number {
  const base = STAGE_PERCENT[stageName];
  if (base === undefined) return 0;
  if (done && stageName === 'export video (Stage F)') return 95;
  if (done) {
    // Return the next stage's starting percent
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

function runWithProgressCapture(
  parsed: ParsedArgs,
  onProgress: (line: string) => void,
): ReturnType<typeof runPipeline> {
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    const str = typeof chunk === 'string' ? chunk : chunk.toString();
    if (str.includes('[motionscore]')) {
      onProgress(str.trim());
    }
    return originalWrite(chunk, ...args);
  }) as typeof process.stderr.write;

  return runPipeline(parsed).finally(() => {
    process.stderr.write = originalWrite;
  });
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

  // Pattern: [motionscore] export progress: N frames encoded
  const exportMatch = line.match(/\[motionscore\] export progress: (\d+) frames encoded$/);
  if (exportMatch) {
    return {
      stage: 'export video (Stage F)',
      message: `Encoding: ${exportMatch[1]} frames encoded`,
      percent: 85,
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

  const job: Job = {
    id: jobId,
    status: 'pending',
    inputPath,
    outputPath,
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
      inputType = detectInputType(inputPath);
    } catch (err: any) {
      job.status = 'error';
      job.error = err.message ?? 'Failed to detect input type';
      emitToJob(job, { status: 'error', message: job.error! });
      scheduleCleanup(job);
      return;
    }

    const options: CLIOptions = {
      input: inputPath,
      output: outputPath,
      fps,
      width,
      height,
      layout,
      verbose: true, // Always verbose so we capture progress
    };

    const parsed: ParsedArgs = { options, inputType };

    try {
      const result = await runWithProgressCapture(parsed, (line) => {
        const event = parseProgressLine(line);
        emitToJob(job, event);
      });

      job.status = 'complete';
      job.stats = result.stats;
      emitToJob(job, {
        status: 'complete',
        stats: result.stats,
        videoUrl: `/api/video/${jobId}`,
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
