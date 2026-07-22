# setup-basic-pitch.ps1
# Sets up a Python virtual environment with Basic Pitch for audio transcription.
# Run from the project root: .\scripts\setup-basic-pitch.ps1

$ErrorActionPreference = "Stop"

$venvDir = Join-Path $PSScriptRoot ".." ".venv"
$venvDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path + "\.venv"

Write-Host "[setup] Creating Python virtual environment at $venvDir ..." -ForegroundColor Cyan

if (Test-Path $venvDir) {
    Write-Host "[setup] .venv already exists, reusing it." -ForegroundColor Yellow
} else {
    python -m venv $venvDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[setup] Failed to create venv. Make sure Python 3 is installed and on PATH." -ForegroundColor Red
        exit 1
    }
}

$pipExe = Join-Path $venvDir "Scripts" "pip.exe"
$pythonExe = Join-Path $venvDir "Scripts" "python.exe"

Write-Host "[setup] Upgrading pip and installing setuptools/wheel ..." -ForegroundColor Cyan
& $pythonExe -m pip install --upgrade pip "setuptools<71" wheel
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] pip upgrade failed" -ForegroundColor Red; exit 1 }

Write-Host "[setup] Installing basic-pitch (ONNX backend) ..." -ForegroundColor Cyan
& $pipExe install "basic-pitch[onnx]==0.4.0" --no-deps
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] basic-pitch install failed" -ForegroundColor Red; exit 1 }

Write-Host "[setup] Installing basic-pitch dependencies ..." -ForegroundColor Cyan
& $pipExe install librosa mir-eval numpy pretty-midi "resampy<0.4.3" scikit-learn scipy typing-extensions onnxruntime
if ($LASTEXITCODE -ne 0) { Write-Host "[setup] dependency install failed" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "[setup] Done! Basic Pitch is ready." -ForegroundColor Green
Write-Host ""
Write-Host "To use audio input, set the PYTHON env var before running:" -ForegroundColor White
Write-Host "  `$env:PYTHON = `"$pythonExe`"" -ForegroundColor Yellow
Write-Host ""
Write-Host "Or add to your .env file:" -ForegroundColor White
Write-Host "  PYTHON=$pythonExe" -ForegroundColor Yellow
