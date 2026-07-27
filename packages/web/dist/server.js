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
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { nanoid } from 'nanoid';
import { analyzeAudio, summarizeAnalysis, detectStemsGpuAvailable, AUDIO_EXTENSIONS, } from '@motionscore/note-extractor';
import { parseAnalyzerProgressLine } from './analyzer-progress.js';
import { RuntimeManager, } from './runtime-manager.js';
// ---------------------------------------------------------------------------
// Resolve the venv Python used for neural stems analysis (PyTorch + Demucs).
// ---------------------------------------------------------------------------
// If PYTHON is unset (or points at a missing venv), fall back to the project's
// .venv so the server "just works" after running the setup script.
const __serverDir = fileURLToPath(new URL('.', import.meta.url));
// Project root is three levels up from packages/web/src/ (or packages/web/dist/).
const PROJECT_ROOT = resolve(process.env.MOTIONSCORE_PROJECT_ROOT?.trim() || resolve(__serverDir, '..', '..', '..'));
{
    const venvCandidates = [
        join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe'), // Windows
        join(PROJECT_ROOT, '.venv', 'bin', 'python'), // POSIX
    ];
    const detectVenv = () => venvCandidates.find((p) => existsSync(p));
    const configured = process.env.PYTHON?.trim();
    let resolvedPython;
    if (configured) {
        const looksLikePath = configured.includes('/') || configured.includes('\\');
        if (!looksLikePath) {
            resolvedPython = configured; // bare command like "python3" -> trust PATH
        }
        else {
            const abs = isAbsolute(configured) ? configured : resolve(PROJECT_ROOT, configured);
            resolvedPython = existsSync(abs) ? abs : detectVenv() ?? abs;
        }
    }
    else {
        resolvedPython = detectVenv();
    }
    if (resolvedPython)
        process.env.PYTHON = resolvedPython;
    console.log(`[motionscore-web] Python for stems analysis: ${process.env.PYTHON ?? '(none found — run the setup script and set PYTHON)'}`);
}
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const CLEANUP_TTL_MS = parseInt(process.env.CLEANUP_TTL_MS ?? String(30 * 60 * 1000), 10);
const UPLOAD_DIR = join(tmpdir(), 'motionscore-uploads');
const STEMS_DIR = join(tmpdir(), 'motionscore-stems');
const AUDIO_CONTENT_TYPES = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
};
const runtimeManager = new RuntimeManager(PROJECT_ROOT);
/** Friendly display labels for the playable Demucs stems. */
const STEM_LABELS = {
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
function readStemManifest(stemsDir) {
    const manifestPath = join(stemsDir, 'stems.json');
    if (!existsSync(manifestPath))
        return [];
    try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (!Array.isArray(raw))
            return [];
        const stems = [];
        for (const entry of raw) {
            if (entry &&
                typeof entry === 'object' &&
                typeof entry.name === 'string' &&
                typeof entry.file === 'string') {
                const name = entry.name;
                // Guard against path traversal from the manifest filename.
                const safe = name.replace(/[^a-z0-9_-]/gi, '');
                const file = join(stemsDir, `${safe}.mp3`);
                if (safe && existsSync(file))
                    stems.push({ name: safe, file });
            }
        }
        return stems;
    }
    catch {
        return [];
    }
}
// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------
const jobs = new Map();
function emitToJob(job, event) {
    job.progress.push(event);
    const data = JSON.stringify(event);
    const terminal = event.status === 'complete' || event.status === 'error';
    for (const res of job.listeners) {
        res.write(`data: ${data}\n\n`);
        if (terminal)
            res.end();
    }
    if (terminal)
        job.listeners.clear();
}
function scheduleCleanup(job) {
    setTimeout(() => {
        try {
            if (existsSync(job.inputPath))
                rmSync(job.inputPath, { force: true });
        }
        catch {
            /* ignore cleanup errors */
        }
        try {
            if (existsSync(job.stemsDir))
                rmSync(job.stemsDir, { recursive: true, force: true });
        }
        catch {
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
async function analyzeWithProgress(job) {
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk, ...args) => {
        const str = typeof chunk === 'string' ? chunk : chunk.toString();
        for (const rawLine of str.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line)
                continue;
            const structured = parseAnalyzerProgressLine(line);
            if (structured) {
                emitToJob(job, structured);
            }
            else if (/separating on|CUDA failed/i.test(line)) {
                emitToJob(job, {
                    stage: 'Source separation',
                    message: line.replace(/^\[motionscore\]\s*/, ''),
                    percent: 35,
                });
            }
            else if (line.includes('[motionscore]')) {
                emitToJob(job, { message: line.replace(/^\[motionscore\]\s*/, '') });
            }
        }
        return originalWrite(chunk, ...args);
    });
    try {
        return await analyzeAudio(job.inputPath, { stemsDir: job.stemsDir });
    }
    finally {
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
        }
        else {
            cb(new Error(`Unsupported file type. Accepted: ${[...AUDIO_EXTENSIONS].join(', ')}`));
        }
    },
});
// GET /api/runtime/status — verify that the analysis runtime is usable.
app.get('/api/runtime/status', async (_req, res) => {
    try {
        res.json(await runtimeManager.inspect());
    }
    catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        res.status(500).json({ error: message });
    }
});
// POST /api/runtime/install — start a private first-run CPU/GPU installation.
app.post('/api/runtime/install', async (req, res) => {
    const mode = req.body?.mode;
    if (mode !== 'cpu' && mode !== 'cuda') {
        res.status(400).json({ error: 'Runtime mode must be "cpu" or "cuda".' });
        return;
    }
    const status = await runtimeManager.inspect();
    if (status.state === 'installing') {
        res.status(409).json({ error: 'Runtime installation is already in progress.' });
        return;
    }
    if (mode === 'cuda' && !status.nvidiaAvailable) {
        res.status(400).json({
            error: 'No NVIDIA driver was detected. Choose the CPU runtime instead.',
        });
        return;
    }
    const installation = runtimeManager.install(mode);
    res.status(202).json({
        accepted: true,
        mode,
        progressUrl: '/api/runtime/progress',
    });
    void installation.catch((cause) => {
        console.error('[motionscore-runtime] installation failed', cause);
    });
});
// GET /api/runtime/progress — replay and stream first-run installation progress.
app.get('/api/runtime/progress', (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const writeEvent = (event) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.status === 'complete' || event.status === 'error')
            res.end();
    };
    for (const event of runtimeManager.progress)
        writeEvent(event);
    const latest = runtimeManager.progress.at(-1);
    if (latest?.status === 'complete' || latest?.status === 'error')
        return;
    const unsubscribe = runtimeManager.subscribe(writeEvent);
    res.on('close', unsubscribe);
});
// POST /api/generate — upload an audio file and start analysis.
app.post('/api/generate', upload.single('file'), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
    }
    const runtime = await runtimeManager.inspect();
    if (!runtime.ready) {
        try {
            rmSync(req.file.path, { force: true });
        }
        catch {
            /* ignore upload cleanup */
        }
        res.status(503).json({
            error: 'The MotionScore analysis runtime is not ready. Complete first-run setup.',
            runtime,
        });
        return;
    }
    const jobId = nanoid(12);
    const originalExt = req.file.originalname.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '.mp3';
    const inputPath = `${req.file.path}${originalExt}`;
    renameSync(req.file.path, inputPath);
    const job = {
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
        emitToJob(job, {
            stage: 'Upload complete',
            message: 'Uploaded — preparing neural analysis',
            percent: 5,
        });
        try {
            const hasGpu = await detectStemsGpuAvailable();
            emitToJob(job, {
                stage: 'Hardware check',
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
                stage: 'Complete',
                status: 'complete',
                message: 'Analysis complete',
                percent: 100,
                analysis: summarizeAnalysis(analysis),
                resultUrl: `/api/result/${jobId}`,
                audioUrl: `/api/audio/${jobId}`,
            });
        }
        catch (err) {
            job.status = 'error';
            job.error = err?.message ?? 'Analysis failed';
            emitToJob(job, { stage: 'Failed', status: 'error', message: job.error });
        }
        scheduleCleanup(job);
    });
});
// GET /api/progress/:jobId — SSE stream.
app.get('/api/progress/:jobId', (req, res) => {
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
    for (const event of job.progress)
        res.write(`data: ${JSON.stringify(event)}\n\n`);
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
app.get('/api/result/:jobId', (req, res) => {
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
app.get('/api/stem/:jobId/:name', (req, res) => {
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
    res.setHeader('Cache-Control', 'private, max-age=1800');
    if (req.query['download'] === '1') {
        res.setHeader('Content-Disposition', `attachment; filename="${stem.name}.mp3"`);
    }
    res.sendFile(stem.file);
});
// GET /api/audio/:jobId — stream the original uploaded audio (range-capable via
// sendFile) so the browser <audio> element can play and seek it.
app.get('/api/audio/:jobId', (req, res) => {
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
const clientDistDir = resolve(process.env.MOTIONSCORE_CLIENT_DIST?.trim() || join(__serverDir, 'client'));
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
    const address = server.address();
    const activePort = address && typeof address !== 'string'
        ? address.port
        : PORT;
    console.log(`[motionscore-web] listening on http://localhost:${activePort}`);
});
export { app, server };
//# sourceMappingURL=server.js.map