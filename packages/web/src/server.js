"use strict";
// @motionscore/web — Express backend exposing the MotionScore pipeline as HTTP API.
//
// Endpoints:
//   POST /api/generate       — upload file + options, returns jobId
//   GET  /api/progress/:id   — SSE stream of pipeline progress
//   GET  /api/video/:id      — serve the generated MP4
//   GET  /api/video/:id/download — serve with Content-Disposition attachment
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a, _b, _c, _d;
Object.defineProperty(exports, "__esModule", { value: true });
exports.server = exports.app = void 0;
var node_http_1 = require("node:http");
var node_fs_1 = require("node:fs");
var node_path_1 = require("node:path");
var node_os_1 = require("node:os");
var node_url_1 = require("node:url");
var express_1 = require("express");
var multer_1 = require("multer");
var cors_1 = require("cors");
var nanoid_1 = require("nanoid");
// ---------------------------------------------------------------------------
// Auto-detect venv Python for Basic Pitch transcription
// ---------------------------------------------------------------------------
// If PYTHON is not already set, look for the project's .venv and use it.
// This means the server "just works" for audio input after running the setup
// script — no manual env var needed.
var __filename = (0, node_url_1.fileURLToPath)(import.meta.url);
var __serverDir = (0, node_url_1.fileURLToPath)(new URL('.', import.meta.url));
// Project root is three levels up from packages/web/src/ (or packages/web/dist/)
var PROJECT_ROOT = (0, node_path_1.resolve)(__serverDir, '..', '..', '..');
// Resolve the Python executable used for audio analysis (librosa / Basic Pitch /
// Demucs). The server must "just work" after a setup script and tolerate a
// PYTHON value that is relative (e.g. ".\.venv\Scripts\python.exe") or points at
// a venv that no longer exists — the server's cwd is not guaranteed to be the
// project root, so a relative path would otherwise fail to spawn.
{
    var venvCandidates_1 = [
        (0, node_path_1.join)(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe'), // Windows
        (0, node_path_1.join)(PROJECT_ROOT, '.venv', 'bin', 'python'), // POSIX
    ];
    var detectVenv = function () { return venvCandidates_1.find(function (p) { return (0, node_fs_1.existsSync)(p); }); };
    var configured = (_a = process.env.PYTHON) === null || _a === void 0 ? void 0 : _a.trim();
    var resolvedPython = void 0;
    if (configured) {
        var looksLikePath = configured.includes('/') || configured.includes('\\');
        if (!looksLikePath) {
            // Bare command such as "python" / "python3": trust PATH resolution as-is.
            resolvedPython = configured;
        }
        else {
            // Make a relative path absolute against the project root, then verify it.
            var abs = (0, node_path_1.isAbsolute)(configured) ? configured : (0, node_path_1.resolve)(PROJECT_ROOT, configured);
            if ((0, node_fs_1.existsSync)(abs)) {
                resolvedPython = abs;
            }
            else {
                var fallback = detectVenv();
                if (fallback) {
                    console.warn("[motionscore-web] PYTHON=\"".concat(configured, "\" was not found (resolved to ").concat(abs, "); ") +
                        "using detected venv Python instead: ".concat(fallback));
                    resolvedPython = fallback;
                }
                else {
                    // Keep the absolute form so the downstream error names a real path and
                    // the setup hint still guides the user.
                    resolvedPython = abs;
                }
            }
        }
    }
    else {
        resolvedPython = detectVenv();
    }
    if (resolvedPython) {
        process.env.PYTHON = resolvedPython;
    }
    console.log("[motionscore-web] Python for audio analysis: ".concat((_b = process.env.PYTHON) !== null && _b !== void 0 ? _b : '(none set — run scripts/setup-audio and set PYTHON)'));
}
// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
var PORT = parseInt((_c = process.env.PORT) !== null && _c !== void 0 ? _c : '3001', 10);
var CLEANUP_TTL_MS = parseInt((_d = process.env.CLEANUP_TTL_MS) !== null && _d !== void 0 ? _d : String(30 * 60 * 1000), 10);
var UPLOAD_DIR = (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'motionscore-uploads');
var OUTPUT_DIR = (0, node_path_1.join)((0, node_os_1.tmpdir)(), 'motionscore-outputs');
// Ensure directories exist
(0, node_fs_1.mkdirSync)(UPLOAD_DIR, { recursive: true });
(0, node_fs_1.mkdirSync)(OUTPUT_DIR, { recursive: true });
// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------
var jobs = new Map();
// ---------------------------------------------------------------------------
// Stage-to-percent mapping
// ---------------------------------------------------------------------------
// Percent shown when each verbose stage STARTS. Keys must match the exact
// stage names emitted by the CLI pipeline's verbose logs (see pipeline.ts).
var STAGE_PERCENT = {
    'check input readable': 3,
    'extract notes (Stage B)': 8,
    'map notes (Stage C)': 22,
    'solve trajectory (Stage D)': 30,
    'check ffmpeg available': 36,
    'render + encode (Stage E+F)': 42,
};
/** The single streaming stage that dominates wall-clock time. */
var RENDER_STAGE = 'render + encode (Stage E+F)';
var RENDER_START_PERCENT = 42;
var RENDER_END_PERCENT = 98;
function estimatePercent(stageName, done) {
    var _a;
    var base = STAGE_PERCENT[stageName];
    if (base === undefined)
        return 0;
    if (done) {
        // The render+encode stage is last; keep the bar near the top when it
        // finishes rather than snapping back to its start percent.
        if (stageName === RENDER_STAGE)
            return RENDER_END_PERCENT;
        var stages = Object.keys(STAGE_PERCENT);
        var idx = stages.indexOf(stageName);
        if (idx >= 0 && idx < stages.length - 1) {
            return (_a = STAGE_PERCENT[stages[idx + 1]]) !== null && _a !== void 0 ? _a : base;
        }
    }
    return base;
}
function runWithProgressCapture(parsed, onProgress) {
    return __awaiter(this, void 0, void 0, function () {
        var runPipeline, originalWrite;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require('@motionscore/cli'); })];
                case 1:
                    runPipeline = (_a.sent()).runPipeline;
                    originalWrite = process.stderr.write.bind(process.stderr);
                    process.stderr.write = (function (chunk) {
                        var args = [];
                        for (var _i = 1; _i < arguments.length; _i++) {
                            args[_i - 1] = arguments[_i];
                        }
                        var str = typeof chunk === 'string' ? chunk : chunk.toString();
                        if (str.includes('[motionscore]')) {
                            onProgress(str.trim());
                        }
                        return originalWrite.apply(void 0, __spreadArray([chunk], args, false));
                    });
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, , 4, 5]);
                    return [4 /*yield*/, runPipeline(parsed)];
                case 3: return [2 /*return*/, _a.sent()];
                case 4:
                    process.stderr.write = originalWrite;
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function parseProgressLine(line) {
    var _a;
    // Pattern: [motionscore] <stage>...
    var startMatch = line.match(/\[motionscore\] (.+)\.\.\.$/);
    if (startMatch) {
        var stage = startMatch[1];
        return {
            stage: stage,
            message: "".concat(stage, " started"),
            percent: estimatePercent(stage, false),
        };
    }
    // Pattern: [motionscore] <stage> done in <time>ms (<detail>)
    var doneMatch = line.match(/\[motionscore\] (.+?) done in ([\d.]+)ms(?: \((.+)\))?$/);
    if (doneMatch) {
        var stage = doneMatch[1];
        var detail = (_a = doneMatch[3]) !== null && _a !== void 0 ? _a : '';
        return {
            stage: stage,
            message: "".concat(stage, " completed").concat(detail ? " (".concat(detail, ")") : ''),
            percent: estimatePercent(stage, true),
        };
    }
    // Pattern: [motionscore] validated ...
    var validateMatch = line.match(/\[motionscore\] (validated .+)$/);
    if (validateMatch) {
        return { message: validateMatch[1] };
    }
    // Pattern: [motionscore] render+encode progress: N/M frames
    var renderMatch = line.match(/\[motionscore\] render\+encode progress: (\d+)\/(\d+) frames$/);
    if (renderMatch) {
        var rendered = parseInt(renderMatch[1], 10);
        var total = parseInt(renderMatch[2], 10);
        var fraction = total > 0 ? Math.min(1, rendered / total) : 0;
        var percent = Math.round(RENDER_START_PERCENT + fraction * (RENDER_END_PERCENT - RENDER_START_PERCENT));
        return {
            stage: RENDER_STAGE,
            message: "Rendering: ".concat(rendered, "/").concat(total, " frames"),
            percent: percent,
        };
    }
    // Fallback
    return { message: line.replace('[motionscore] ', '') };
}
function emitToJob(job, event) {
    job.progress.push(event);
    var data = JSON.stringify(event);
    for (var _i = 0, _a = job.listeners; _i < _a.length; _i++) {
        var res = _a[_i];
        res.write("data: ".concat(data, "\n\n"));
    }
}
// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
function scheduleCleanup(job) {
    setTimeout(function () {
        try {
            if ((0, node_fs_1.existsSync)(job.inputPath))
                (0, node_fs_1.rmSync)(job.inputPath, { force: true });
            if ((0, node_fs_1.existsSync)(job.outputPath))
                (0, node_fs_1.rmSync)(job.outputPath, { force: true });
        }
        catch (_a) {
            // Ignore cleanup errors
        }
        jobs.delete(job.id);
    }, CLEANUP_TTL_MS);
}
// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
var app = (0, express_1.default)();
exports.app = app;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Multer config for file uploads
var upload = (0, multer_1.default)({
    dest: UPLOAD_DIR,
    limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
    fileFilter: function (_req, file, cb) {
        var _a;
        var allowed = ['.mid', '.midi', '.wav', '.mp3', '.flac', '.ogg'];
        var ext = (_a = file.originalname.toLowerCase().match(/\.[^.]+$/)) === null || _a === void 0 ? void 0 : _a[0];
        if (ext && allowed.includes(ext)) {
            cb(null, true);
        }
        else {
            cb(new Error("Unsupported file type. Accepted: ".concat(allowed.join(', '))));
        }
    },
});
// GET /api/encoders — list available H.264 encoders (for the frontend dropdown)
app.get('/api/encoders', function (_req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var detectAvailableEncoders, encoders, descriptions;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: return [4 /*yield*/, Promise.resolve().then(function () { return require('@motionscore/video-export'); })];
            case 1:
                detectAvailableEncoders = (_a.sent()).detectAvailableEncoders;
                return [4 /*yield*/, detectAvailableEncoders()];
            case 2:
                encoders = _a.sent();
                descriptions = {
                    'libx264': 'CPU (libx264)',
                    'h264_nvenc': 'NVIDIA GPU (NVENC)',
                    'h264_amf': 'AMD GPU (AMF)',
                    'h264_qsv': 'Intel GPU (Quick Sync)',
                };
                res.json(encoders.map(function (enc) { var _a; return ({ id: enc, label: (_a = descriptions[enc]) !== null && _a !== void 0 ? _a : enc }); }));
                return [2 /*return*/];
        }
    });
}); });
// POST /api/generate — start a new generation job
app.post('/api/generate', upload.single('file'), function (req, res) { return __awaiter(void 0, void 0, void 0, function () {
    var jobId, originalExt, inputPath, renameSync, outputPath, fps, width, height, layout, ALLOWED_MODES, mode, ALLOWED_BALLS, balls, codec, gpuDevice, preset, parallelFrames, job;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                if (!req.file) {
                    res.status(400).json({ error: 'No file uploaded' });
                    return [2 /*return*/];
                }
                jobId = (0, nanoid_1.nanoid)(12);
                originalExt = (_b = (_a = req.file.originalname.toLowerCase().match(/\.[^.]+$/)) === null || _a === void 0 ? void 0 : _a[0]) !== null && _b !== void 0 ? _b : '.mid';
                inputPath = "".concat(req.file.path).concat(originalExt);
                return [4 /*yield*/, Promise.resolve().then(function () { return require('node:fs'); })];
            case 1:
                renameSync = (_c.sent()).renameSync;
                renameSync(req.file.path, inputPath);
                outputPath = (0, node_path_1.join)(OUTPUT_DIR, "".concat(jobId, ".mp4"));
                fps = req.body.fps ? parseInt(req.body.fps, 10) : 60;
                width = req.body.width ? parseInt(req.body.width, 10) : 1920;
                height = req.body.height ? parseInt(req.body.height, 10) : 1080;
                layout = req.body.layout === 'lanes' ? 'lanes' : 'piano-keys';
                ALLOWED_MODES = ['auto', 'beats', 'onsets', 'stems', 'notes'];
                mode = ALLOWED_MODES.includes(req.body.mode) ? req.body.mode : 'auto';
                ALLOWED_BALLS = ['single', 'per-role'];
                balls = ALLOWED_BALLS.includes(req.body.balls) ? req.body.balls : 'single';
                codec = req.body.codec || undefined;
                gpuDevice = req.body.gpuDevice !== undefined ? parseInt(req.body.gpuDevice, 10) : undefined;
                preset = req.body.preset || undefined;
                parallelFrames = req.body.parallelFrames ? parseInt(req.body.parallelFrames, 10) : 4;
                job = {
                    id: jobId,
                    status: 'pending',
                    inputPath: inputPath,
                    outputPath: outputPath,
                    inputExt: originalExt,
                    progress: [],
                    createdAt: Date.now(),
                    listeners: new Set(),
                };
                jobs.set(jobId, job);
                // Return job ID immediately
                res.json({ jobId: jobId, progressUrl: "/api/progress/".concat(jobId) });
                // Run pipeline in background
                setImmediate(function () { return __awaiter(void 0, void 0, void 0, function () {
                    var inputType, detectInputType, err_1, effectiveMode, detectStemsGpuAvailable, _a, options, parsed, result, hasVideo, err_2;
                    var _b, _c;
                    return __generator(this, function (_d) {
                        switch (_d.label) {
                            case 0:
                                job.status = 'running';
                                _d.label = 1;
                            case 1:
                                _d.trys.push([1, 3, , 4]);
                                return [4 /*yield*/, Promise.resolve().then(function () { return require('@motionscore/cli'); })];
                            case 2:
                                detectInputType = (_d.sent()).detectInputType;
                                inputType = detectInputType(inputPath);
                                return [3 /*break*/, 4];
                            case 3:
                                err_1 = _d.sent();
                                job.status = 'error';
                                job.error = (_b = err_1.message) !== null && _b !== void 0 ? _b : 'Failed to detect input type';
                                emitToJob(job, { status: 'error', message: job.error });
                                scheduleCleanup(job);
                                return [2 /*return*/];
                            case 4:
                                job.inputType = inputType;
                                effectiveMode = mode;
                                if (!(inputType === 'audio' && mode === 'auto')) return [3 /*break*/, 9];
                                _d.label = 5;
                            case 5:
                                _d.trys.push([5, 8, , 9]);
                                return [4 /*yield*/, Promise.resolve().then(function () { return require('@motionscore/cli'); })];
                            case 6:
                                detectStemsGpuAvailable = (_d.sent()).detectStemsGpuAvailable;
                                return [4 /*yield*/, detectStemsGpuAvailable()];
                            case 7:
                                if (_d.sent()) {
                                    effectiveMode = 'stems';
                                    emitToJob(job, {
                                        message: 'GPU detected — using neural per-instrument separation (stems)',
                                        percent: 6,
                                    });
                                }
                                return [3 /*break*/, 9];
                            case 8:
                                _a = _d.sent();
                                return [3 /*break*/, 9];
                            case 9:
                                options = {
                                    input: inputPath,
                                    output: outputPath,
                                    mode: effectiveMode,
                                    balls: balls,
                                    fps: fps,
                                    width: width,
                                    height: height,
                                    layout: layout,
                                    verbose: true, // Always verbose so we capture progress
                                    codec: codec,
                                    gpuDevice: gpuDevice,
                                    preset: preset,
                                    parallelFrames: parallelFrames,
                                    // Audio inputs power the real-time 2D renderer, which needs only the
                                    // analysis + choreography + original audio — so skip the slow MP4 render
                                    // (the browser plays /api/audio directly). MIDI has no playable audio, so
                                    // it still renders a video-only MP4.
                                    skipRender: inputType === 'audio',
                                };
                                parsed = { options: options, inputType: inputType };
                                _d.label = 10;
                            case 10:
                                _d.trys.push([10, 12, , 13]);
                                return [4 /*yield*/, runWithProgressCapture(parsed, function (line) {
                                        var event = parseProgressLine(line);
                                        emitToJob(job, event);
                                    })];
                            case 11:
                                result = _d.sent();
                                job.status = 'complete';
                                job.stats = result.stats;
                                job.choreography = result.choreography;
                                job.analysisFull = result.audioAnalysis;
                                hasVideo = job.inputType !== 'audio';
                                emitToJob(job, {
                                    status: 'complete',
                                    stats: result.stats,
                                    analysis: result.analysis,
                                    videoUrl: hasVideo ? "/api/video/".concat(jobId) : undefined,
                                    resultUrl: "/api/result/".concat(jobId),
                                    audioUrl: job.inputType === 'audio' ? "/api/audio/".concat(jobId) : undefined,
                                    message: 'Pipeline complete',
                                    percent: 100,
                                });
                                return [3 /*break*/, 13];
                            case 12:
                                err_2 = _d.sent();
                                job.status = 'error';
                                job.error = (_c = err_2.message) !== null && _c !== void 0 ? _c : 'Pipeline failed';
                                emitToJob(job, { status: 'error', message: job.error });
                                return [3 /*break*/, 13];
                            case 13:
                                scheduleCleanup(job);
                                return [2 /*return*/];
                        }
                    });
                }); });
                return [2 /*return*/];
        }
    });
}); });
// GET /api/progress/:jobId — SSE endpoint
app.get('/api/progress/:jobId', function (req, res) {
    var jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    var job = jobs.get(jobId);
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
    for (var _i = 0, _a = job.progress; _i < _a.length; _i++) {
        var event_1 = _a[_i];
        res.write("data: ".concat(JSON.stringify(event_1), "\n\n"));
    }
    // If job is already done, close
    if (job.status === 'complete' || job.status === 'error') {
        res.end();
        return;
    }
    // Otherwise register as listener
    job.listeners.add(res);
    req.on('close', function () {
        job.listeners.delete(res);
    });
});
// GET /api/video/:jobId — serve generated MP4
app.get('/api/video/:jobId', function (req, res) {
    var jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    var job = jobs.get(jobId);
    if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
    }
    if (job.status !== 'complete') {
        res.status(409).json({ error: 'Video not ready yet', status: job.status });
        return;
    }
    if (!(0, node_fs_1.existsSync)(job.outputPath)) {
        res.status(410).json({ error: 'Video has been cleaned up' });
        return;
    }
    var stat = (0, node_fs_1.statSync)(job.outputPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.sendFile(job.outputPath);
});
// GET /api/video/:jobId/download — serve with attachment header
app.get('/api/video/:jobId/download', function (req, res) {
    var jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    var job = jobs.get(jobId);
    if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
    }
    if (job.status !== 'complete') {
        res.status(409).json({ error: 'Video not ready yet', status: job.status });
        return;
    }
    if (!(0, node_fs_1.existsSync)(job.outputPath)) {
        res.status(410).json({ error: 'Video has been cleaned up' });
        return;
    }
    res.setHeader('Content-Disposition', "attachment; filename=\"motionscore-".concat(job.id, ".mp4\""));
    res.sendFile(job.outputPath);
});
// GET /api/result/:jobId — full choreography + rich analysis JSON for the
// real-time (Three.js) renderer. Kept separate from the SSE progress frame so
// large trajectory/analysis payloads don't bloat the event stream.
app.get('/api/result/:jobId', function (req, res) {
    var _a, _b, _c, _d, _e, _f, _g;
    var jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    var job = jobId ? jobs.get(jobId) : undefined;
    if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
    }
    if (job.status !== 'complete') {
        res.status(409).json({ error: 'Result not ready yet', status: job.status });
        return;
    }
    res.json({
        durationSec: (_d = (_b = (_a = job.stats) === null || _a === void 0 ? void 0 : _a.durationSec) !== null && _b !== void 0 ? _b : (_c = job.choreography) === null || _c === void 0 ? void 0 : _c.durationSec) !== null && _d !== void 0 ? _d : 0,
        inputType: (_e = job.inputType) !== null && _e !== void 0 ? _e : 'audio',
        hasAudio: job.inputType === 'audio',
        audioUrl: job.inputType === 'audio' ? "/api/audio/".concat(jobId) : null,
        videoUrl: job.inputType === 'audio' ? null : "/api/video/".concat(jobId),
        choreography: (_f = job.choreography) !== null && _f !== void 0 ? _f : null,
        analysis: (_g = job.analysisFull) !== null && _g !== void 0 ? _g : null,
    });
});
// GET /api/audio/:jobId — stream the ORIGINAL uploaded audio so the browser can
// play it in sync with the real-time renderer. Only audio inputs have a
// playable track (MIDI is video-only). res.sendFile supports Range requests, so
// the <audio> element can seek.
var AUDIO_CONTENT_TYPES = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
};
app.get('/api/audio/:jobId', function (req, res) {
    var _a, _b;
    var jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    var job = jobId ? jobs.get(jobId) : undefined;
    if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
    }
    if (job.inputType !== 'audio') {
        res.status(404).json({ error: 'No playable audio for this input' });
        return;
    }
    if (!(0, node_fs_1.existsSync)(job.inputPath)) {
        res.status(410).json({ error: 'Audio has been cleaned up' });
        return;
    }
    var ext = (_a = job.inputExt) !== null && _a !== void 0 ? _a : '.mp3';
    res.setHeader('Content-Type', (_b = AUDIO_CONTENT_TYPES[ext]) !== null && _b !== void 0 ? _b : 'application/octet-stream');
    res.sendFile(job.inputPath);
});
// ---------------------------------------------------------------------------
// Serve static frontend in production
// ---------------------------------------------------------------------------
var __dirname = (0, node_url_1.fileURLToPath)(new URL('.', import.meta.url));
var clientDistDir = (0, node_path_1.join)(__dirname, 'client');
if ((0, node_fs_1.existsSync)(clientDistDir)) {
    app.use(express_1.default.static(clientDistDir));
    // SPA fallback
    app.get('*', function (_req, res) {
        res.sendFile((0, node_path_1.join)(clientDistDir, 'index.html'));
    });
}
// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
var server = (0, node_http_1.createServer)(app);
exports.server = server;
server.listen(PORT, function () {
    console.log("[motionscore-web] listening on http://localhost:".concat(PORT));
});
