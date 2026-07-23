# setup-demucs.ps1
# Sets up PyTorch + Demucs for neural per-instrument analysis (--mode stems).
# Reuses the project .venv (same one used by scripts\setup-audio.ps1).
# Run from the project root:
#   .\scripts\setup-demucs.ps1          # CUDA build (NVIDIA GPU, CUDA 12.1 wheels)
#   .\scripts\setup-demucs.ps1 -Cpu     # CPU-only build (no GPU / troubleshooting)

param(
    [switch]$Cpu
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venvDir = Join-Path $projectRoot ".venv"

Write-Host "[setup] Preparing Demucs (neural stems) environment at $venvDir ..." -ForegroundColor Cyan

if (Test-Path $venvDir) {
    Write-Host "[setup] .venv already exists, reusing it." -ForegroundColor Yellow
} else {
    python -m venv $venvDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[setup] Failed to create venv. Install Python 3 and ensure python is on PATH." -ForegroundColor Red
        exit 1
    }
}

$pythonExe = Join-Path $venvDir "Scripts" "python.exe"

Write-Host "[setup] Upgrading pip ..." -ForegroundColor Cyan
& $pythonExe -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] pip upgrade failed" -ForegroundColor Red; exit 1 }

# librosa powers the onset/feature/cue analysis that runs on the separated stems.
Write-Host "[setup] Ensuring librosa 0.11.0 is installed ..." -ForegroundColor Cyan
& $pythonExe -m pip install "librosa==0.11.0"
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] librosa install failed" -ForegroundColor Red; exit 1 }

if ($Cpu) {
    Write-Host "[setup] Installing PyTorch 2.4.1 (CPU build) ..." -ForegroundColor Cyan
    & $pythonExe -m pip install "torch==2.4.1" "torchaudio==2.4.1"
} else {
    Write-Host "[setup] Installing PyTorch 2.4.1 (CUDA 12.1 build) ..." -ForegroundColor Cyan
    Write-Host "[setup] (~2.4 GB download. For CPU-only machines re-run with -Cpu.)" -ForegroundColor DarkGray
    & $pythonExe -m pip install "torch==2.4.1" "torchaudio==2.4.1" --index-url https://download.pytorch.org/whl/cu121
}
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] PyTorch install failed" -ForegroundColor Red; exit 1 }

Write-Host "[setup] Installing Demucs 4.0.1 ..." -ForegroundColor Cyan
& $pythonExe -m pip install "demucs==4.0.1"
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] Demucs install failed" -ForegroundColor Red; exit 1 }

Write-Host "[setup] Verifying the install ..." -ForegroundColor Cyan
& $pythonExe -c "import torch, demucs, librosa; print('torch', torch.__version__, 'cuda', torch.cuda.is_available()); print('demucs', demucs.__version__)"
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] Verification import failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "[setup] Neural stems analysis is ready (--mode stems)." -ForegroundColor Green
Write-Host "The htdemucs_6s model (~170 MB) downloads automatically on first use." -ForegroundColor White
Write-Host "Set PYTHON before running MotionScore:" -ForegroundColor White
Write-Host "  `$env:PYTHON = `"$pythonExe`"" -ForegroundColor Yellow
