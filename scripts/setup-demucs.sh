#!/usr/bin/env bash
# Sets up PyTorch + Demucs for neural per-instrument analysis (--mode stems).
# Reuses the project .venv (same one used by scripts/setup-audio.sh).
# Run from the project root:
#   ./scripts/setup-demucs.sh          # CUDA build (NVIDIA GPU, CUDA 12.1 wheels)
#   ./scripts/setup-demucs.sh --cpu    # CPU-only build (no GPU / macOS / troubleshooting)

set -euo pipefail

CPU_ONLY=0
if [ "${1:-}" = "--cpu" ]; then
    CPU_ONLY=1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$PROJECT_ROOT/.venv"

echo "[setup] Preparing Demucs (neural stems) environment at $VENV_DIR ..."

if [ -d "$VENV_DIR" ]; then
    echo "[setup] .venv already exists, reusing it."
else
    python3 -m venv "$VENV_DIR"
fi

PYTHON_EXE="$VENV_DIR/bin/python"

echo "[setup] Upgrading pip ..."
"$PYTHON_EXE" -m pip install --upgrade pip

# librosa powers the onset/feature/cue analysis that runs on the separated stems.
echo "[setup] Ensuring librosa 0.11.0 is installed ..."
"$PYTHON_EXE" -m pip install "librosa==0.11.0"

# macOS has no CUDA wheels; force CPU/MPS build there regardless of the flag.
if [ "$(uname -s)" = "Darwin" ]; then
    CPU_ONLY=1
fi

if [ "$CPU_ONLY" -eq 1 ]; then
    echo "[setup] Installing PyTorch 2.4.1 (CPU/MPS build) ..."
    "$PYTHON_EXE" -m pip install "torch==2.4.1" "torchaudio==2.4.1"
else
    echo "[setup] Installing PyTorch 2.4.1 (CUDA 12.1 build) ..."
    echo "[setup] (~2.4 GB download. For CPU-only machines re-run with --cpu.)"
    "$PYTHON_EXE" -m pip install "torch==2.4.1" "torchaudio==2.4.1" --index-url https://download.pytorch.org/whl/cu121
fi

echo "[setup] Installing Demucs 4.0.1 ..."
"$PYTHON_EXE" -m pip install "demucs==4.0.1"

echo "[setup] Verifying the install ..."
"$PYTHON_EXE" -c "import torch, demucs, librosa; print('torch', torch.__version__, 'cuda', torch.cuda.is_available()); print('demucs', demucs.__version__)"

echo
echo "[setup] Neural stems analysis is ready (--mode stems)."
echo "The htdemucs_6s model (~170 MB) downloads automatically on first use."
echo "Set PYTHON before running MotionScore:"
echo "  export PYTHON=\"$PYTHON_EXE\""
