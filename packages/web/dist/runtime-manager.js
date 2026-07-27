import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, } from 'node:fs';
import { open } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
const PYTHON_VERSION = '3.11.9';
const PYTHON_INSTALLER_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-amd64.exe`;
const TORCH_VERSION = '2.4.1';
const DEMUCS_VERSION = '4.0.1';
const LIBROSA_VERSION = '0.11.0';
const IMAGEIO_FFMPEG_VERSION = '0.6.0';
function runProcess(executable, args, options = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(executable, [...args], {
            shell: false,
            windowsHide: true,
            env: options.env ?? process.env,
        });
        let stdout = '';
        let stderr = '';
        const forward = (chunk, target) => {
            const text = chunk.toString();
            if (target === 'stdout')
                stdout += text;
            else
                stderr += text;
            for (const line of text.split(/\r?\n/)) {
                const clean = line.trim();
                if (clean)
                    options.onLine?.(clean);
            }
        };
        child.stdout.on('data', (chunk) => forward(chunk, 'stdout'));
        child.stderr.on('data', (chunk) => forward(chunk, 'stderr'));
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0)
                resolvePromise({ stdout, stderr });
            else {
                const detail = stderr.trim() || stdout.trim() || `exit code ${code ?? 'unknown'}`;
                reject(new Error(`${executable} failed: ${detail}`));
            }
        });
    });
}
function commandExists(command) {
    const checker = process.platform === 'win32' ? 'where.exe' : 'which';
    return runProcess(checker, [command]).then(() => true, () => false);
}
function cleanInstallerLine(line) {
    const compact = line.replace(/\s+/g, ' ').trim();
    return compact.length > 150 ? `${compact.slice(0, 147)}...` : compact;
}
async function verifyPythonInstaller(installerPath) {
    const escapedPath = installerPath.replace(/'/g, "''");
    const script = [
        `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedPath}'`,
        "if ($signature.Status -ne 'Valid') { Write-Error \"Python installer signature is $($signature.Status)\"; exit 1 }",
        "if ($signature.SignerCertificate.Subject -notlike '*Python Software Foundation*') { Write-Error 'Unexpected Python installer publisher'; exit 1 }",
        "Write-Output 'Python Software Foundation signature verified'",
    ].join('; ');
    await runProcess('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
    ]);
}
export class RuntimeManager {
    runtimeRoot;
    pythonRoot;
    managedPython;
    binDir;
    ffmpegPath;
    markerPath;
    installing = false;
    latestError;
    events = [];
    listeners = new Set();
    constructor(projectRoot) {
        this.runtimeRoot = resolve(process.env.MOTIONSCORE_RUNTIME_ROOT?.trim() ||
            join(projectRoot, '.motionscore-runtime'));
        this.pythonRoot = join(this.runtimeRoot, 'python');
        this.managedPython =
            process.platform === 'win32'
                ? join(this.pythonRoot, 'python.exe')
                : join(this.pythonRoot, 'bin', 'python3');
        this.binDir = join(this.runtimeRoot, 'bin');
        this.ffmpegPath =
            process.platform === 'win32'
                ? join(this.binDir, 'ffmpeg.exe')
                : join(this.binDir, 'ffmpeg');
        this.markerPath = join(this.runtimeRoot, 'runtime.json');
    }
    get progress() {
        return this.events;
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(event) {
        this.events.push(event);
        for (const listener of this.listeners)
            listener(event);
    }
    candidatePython() {
        if (process.env.MOTIONSCORE_FORCE_RUNTIME_SETUP === '1') {
            return existsSync(this.managedPython) ? this.managedPython : null;
        }
        const configured = process.env.PYTHON?.trim();
        if (configured) {
            const looksLikePath = configured.includes('/') || configured.includes('\\');
            if (!looksLikePath || existsSync(isAbsolute(configured) ? configured : resolve(configured))) {
                return configured;
            }
        }
        if (existsSync(this.managedPython))
            return this.managedPython;
        return null;
    }
    applyEnvironment(pythonPath, ffmpegPath) {
        process.env.PYTHON = pythonPath;
        process.env.TORCH_HOME = join(this.runtimeRoot, 'models');
        const usableFfmpeg = ffmpegPath && existsSync(ffmpegPath) ? ffmpegPath : undefined;
        if (usableFfmpeg)
            process.env.IMAGEIO_FFMPEG_EXE = usableFfmpeg;
        if (existsSync(this.binDir)) {
            const pathEntries = (process.env.PATH ?? '').split(delimiter);
            if (!pathEntries.includes(this.binDir)) {
                process.env.PATH = `${this.binDir}${delimiter}${process.env.PATH ?? ''}`;
            }
        }
    }
    async probe(pythonPath, deep = false) {
        const scriptLines = deep
            ? [
                'import json, platform, torch, demucs, librosa',
                'payload = {',
                '  "pythonVersion": platform.python_version(),',
                '  "torchVersion": torch.__version__,',
                '  "cuda": bool(torch.cuda.is_available()),',
                '}',
            ]
            : [
                'import importlib.metadata as md, importlib.util, json, platform',
                'required = ["torch", "torchaudio", "demucs", "librosa"]',
                'missing = [name for name in required if importlib.util.find_spec(name) is None]',
                'if missing: raise ModuleNotFoundError(", ".join(missing))',
                'torch_version = md.version("torch")',
                'payload = {',
                '  "pythonVersion": platform.python_version(),',
                '  "torchVersion": torch_version,',
                '  "cuda": "+cu" in torch_version.lower(),',
                '}',
            ];
        scriptLines.push('try:', '  import imageio_ffmpeg', '  payload["ffmpegPath"] = imageio_ffmpeg.get_ffmpeg_exe()', 'except Exception:', '  pass', 'print(json.dumps(payload))');
        const script = scriptLines.join('\n');
        const result = await runProcess(pythonPath, ['-c', script], {
            env: {
                ...process.env,
                TORCH_HOME: join(this.runtimeRoot, 'models'),
            },
        });
        const line = result.stdout
            .split(/\r?\n/)
            .map((value) => value.trim())
            .find((value) => value.startsWith('{'));
        if (!line)
            throw new Error('Runtime verification returned no version information.');
        return JSON.parse(line);
    }
    async inspect() {
        const nvidiaAvailable = await commandExists('nvidia-smi');
        const pythonPath = this.candidatePython();
        if (!pythonPath) {
            return {
                state: this.installing ? 'installing' : this.latestError ? 'error' : 'missing',
                ready: false,
                managed: false,
                mode: null,
                pythonPath: null,
                pythonVersion: null,
                torchVersion: null,
                ffmpegReady: existsSync(this.ffmpegPath) || (await commandExists('ffmpeg')),
                nvidiaAvailable,
                runtimeRoot: this.runtimeRoot,
                ...(this.latestError ? { error: this.latestError } : {}),
            };
        }
        try {
            const payload = await this.probe(pythonPath);
            let ffmpegReady = existsSync(this.ffmpegPath) ||
                (payload.ffmpegPath ? existsSync(payload.ffmpegPath) : false) ||
                (await commandExists('ffmpeg'));
            if (payload.ffmpegPath && existsSync(payload.ffmpegPath) && !existsSync(this.ffmpegPath)) {
                mkdirSync(this.binDir, { recursive: true });
                copyFileSync(payload.ffmpegPath, this.ffmpegPath);
                ffmpegReady = true;
            }
            this.applyEnvironment(pythonPath, ffmpegReady ? this.ffmpegPath : payload.ffmpegPath);
            const ready = !this.installing && ffmpegReady;
            return {
                state: this.installing ? 'installing' : ready ? 'ready' : 'missing',
                ready,
                managed: resolve(pythonPath).startsWith(this.runtimeRoot),
                mode: payload.cuda ? 'cuda' : 'cpu',
                pythonPath,
                pythonVersion: payload.pythonVersion,
                torchVersion: payload.torchVersion,
                ffmpegReady,
                nvidiaAvailable,
                runtimeRoot: this.runtimeRoot,
            };
        }
        catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            return {
                state: this.installing ? 'installing' : 'missing',
                ready: false,
                managed: resolve(pythonPath).startsWith(this.runtimeRoot),
                mode: null,
                pythonPath,
                pythonVersion: null,
                torchVersion: null,
                ffmpegReady: existsSync(this.ffmpegPath) || (await commandExists('ffmpeg')),
                nvidiaAvailable,
                runtimeRoot: this.runtimeRoot,
                error: this.installing ? undefined : message,
            };
        }
    }
    async download(url, destination) {
        const response = await fetch(url);
        if (!response.ok || !response.body) {
            throw new Error(`Download failed (${response.status}) from ${url}`);
        }
        const total = Number(response.headers.get('content-length') ?? 0);
        const reader = response.body.getReader();
        const file = await open(destination, 'w');
        let received = 0;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                await file.write(value);
                received += value.byteLength;
                const fraction = total > 0 ? received / total : 0;
                this.emit({
                    stage: 'Python download',
                    message: total > 0
                        ? `Downloading private Python (${Math.round(received / 1_048_576)} of ${Math.round(total / 1_048_576)} MB)`
                        : `Downloading private Python (${Math.round(received / 1_048_576)} MB)`,
                    percent: 5 + Math.round(fraction * 10),
                });
            }
        }
        finally {
            await file.close();
        }
    }
    async install(mode) {
        if (this.installing)
            throw new Error('Runtime installation is already in progress.');
        if (process.platform !== 'win32') {
            throw new Error('The automatic runtime installer currently supports Windows x64.');
        }
        this.installing = true;
        this.latestError = undefined;
        this.events = [];
        mkdirSync(this.runtimeRoot, { recursive: true });
        mkdirSync(join(this.runtimeRoot, 'downloads'), { recursive: true });
        mkdirSync(join(this.runtimeRoot, 'models'), { recursive: true });
        const installerPath = join(this.runtimeRoot, 'downloads', `python-${PYTHON_VERSION}-amd64.exe`);
        try {
            this.emit({
                stage: 'Preparing',
                message: `Preparing the private ${mode === 'cuda' ? 'NVIDIA GPU' : 'CPU'} runtime`,
                percent: 2,
            });
            if (!existsSync(this.managedPython)) {
                if (!existsSync(installerPath)) {
                    await this.download(PYTHON_INSTALLER_URL, installerPath);
                }
                this.emit({
                    stage: 'Security check',
                    message: 'Verifying the Python Software Foundation signature',
                    percent: 16,
                });
                try {
                    await verifyPythonInstaller(installerPath);
                }
                catch (cause) {
                    rmSync(installerPath, { force: true });
                    throw cause;
                }
                this.emit({
                    stage: 'Python install',
                    message: 'Installing Python privately for MotionScore',
                    percent: 17,
                });
                await runProcess(installerPath, [
                    '/quiet',
                    'InstallAllUsers=0',
                    'PrependPath=0',
                    'Include_launcher=0',
                    'Include_test=0',
                    'Include_doc=0',
                    'Include_dev=0',
                    'Include_symbols=0',
                    'Include_debug=0',
                    'Include_tcltk=0',
                    'Include_pip=1',
                    `TargetDir=${this.pythonRoot}`,
                ]);
            }
            if (!existsSync(this.managedPython)) {
                throw new Error('Python installation completed but python.exe was not found.');
            }
            this.emit({
                stage: 'Package tools',
                message: 'Updating the Python package installer',
                percent: 24,
            });
            await runProcess(this.managedPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', 'pip', 'setuptools', 'wheel'], {
                onLine: (line) => this.emit({
                    stage: 'Package tools',
                    message: cleanInstallerLine(line),
                    percent: 27,
                }),
            });
            this.emit({
                stage: 'PyTorch',
                message: mode === 'cuda'
                    ? 'Downloading PyTorch with NVIDIA CUDA support'
                    : 'Downloading the CPU analysis engine',
                percent: 32,
            });
            const torchIndex = mode === 'cuda'
                ? 'https://download.pytorch.org/whl/cu121'
                : 'https://download.pytorch.org/whl/cpu';
            await runProcess(this.managedPython, [
                '-m',
                'pip',
                'install',
                '--disable-pip-version-check',
                `torch==${TORCH_VERSION}`,
                `torchaudio==${TORCH_VERSION}`,
                '--index-url',
                torchIndex,
            ], {
                onLine: (line) => this.emit({
                    stage: 'PyTorch',
                    message: cleanInstallerLine(line),
                    percent: 48,
                }),
            });
            this.emit({
                stage: 'Music analysis',
                message: 'Installing Demucs, librosa, and the private audio decoder',
                percent: 62,
            });
            await runProcess(this.managedPython, [
                '-m',
                'pip',
                'install',
                '--disable-pip-version-check',
                `demucs==${DEMUCS_VERSION}`,
                `librosa==${LIBROSA_VERSION}`,
                `imageio-ffmpeg==${IMAGEIO_FFMPEG_VERSION}`,
            ], {
                onLine: (line) => this.emit({
                    stage: 'Music analysis',
                    message: cleanInstallerLine(line),
                    percent: 76,
                }),
            });
            this.emit({
                stage: 'Verification',
                message: 'Checking Python, PyTorch, Demucs, librosa, and FFmpeg',
                percent: 84,
            });
            const payload = await this.probe(this.managedPython, true);
            if (!payload.ffmpegPath || !existsSync(payload.ffmpegPath)) {
                throw new Error('The private FFmpeg decoder could not be located.');
            }
            mkdirSync(this.binDir, { recursive: true });
            copyFileSync(payload.ffmpegPath, this.ffmpegPath);
            this.applyEnvironment(this.managedPython, this.ffmpegPath);
            this.emit({
                stage: 'Model download',
                message: 'Downloading and caching the htdemucs_6s separation model',
                percent: 90,
            });
            await runProcess(this.managedPython, [
                '-c',
                "from demucs.pretrained import get_model; get_model('htdemucs_6s'); print('model ready')",
            ], {
                env: {
                    ...process.env,
                    TORCH_HOME: join(this.runtimeRoot, 'models'),
                },
                onLine: (line) => this.emit({
                    stage: 'Model download',
                    message: cleanInstallerLine(line),
                    percent: 95,
                }),
            });
            const marker = {
                version: 1,
                installedAt: new Date().toISOString(),
                mode,
                pythonVersion: payload.pythonVersion,
                torchVersion: payload.torchVersion,
                pythonPath: this.managedPython,
                ffmpegPath: this.ffmpegPath,
            };
            writeFileSync(this.markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
            rmSync(installerPath, { force: true });
            this.emit({
                stage: 'Ready',
                message: 'MotionScore is ready to analyze music',
                percent: 100,
                status: 'complete',
            });
        }
        catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            this.latestError = message;
            this.emit({
                stage: 'Setup failed',
                message,
                percent: this.events.at(-1)?.percent ?? 0,
                status: 'error',
            });
            throw cause;
        }
        finally {
            this.installing = false;
        }
    }
    readMarker() {
        if (!existsSync(this.markerPath))
            return null;
        try {
            return JSON.parse(readFileSync(this.markerPath, 'utf8'));
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=runtime-manager.js.map