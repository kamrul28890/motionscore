# setup-audio.ps1
# Lightweight setup for smart/beats/onsets audio analysis (no Basic Pitch/ONNX).
# Run from the project root: .\scripts\setup-audio.ps1

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$venvDir = Join-Path $projectRoot ".venv"

Write-Host "[setup] Preparing audio-analysis environment at $venvDir ..." -ForegroundColor Cyan

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

Write-Host "[setup] Installing librosa 0.11.0 and its audio dependencies ..." -ForegroundColor Cyan
& $pythonExe -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] pip upgrade failed" -ForegroundColor Red; exit 1 }
& $pythonExe -m pip install "librosa==0.11.0"
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] librosa install failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "[setup] Smart audio analysis is ready." -ForegroundColor Green
Write-Host "Set PYTHON before running MotionScore:" -ForegroundColor White
Write-Host "  `$env:PYTHON = `"$pythonExe`"" -ForegroundColor Yellow
Write-Host ""
Write-Host "For optional --mode notes transcription, also run scripts\setup-basic-pitch.ps1." -ForegroundColor White
