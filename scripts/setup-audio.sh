#!/usr/bin/env bash
# Lightweight setup for smart/beats/onsets audio analysis (no Basic Pitch/ONNX).
# Run from the project root: ./scripts/setup-audio.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$PROJECT_ROOT/.venv"

echo "[setup] Preparing audio-analysis environment at $VENV_DIR ..."

if [ -d "$VENV_DIR" ]; then
    echo "[setup] .venv already exists, reusing it."
else
    python3 -m venv "$VENV_DIR"
fi

PYTHON_EXE="$VENV_DIR/bin/python"

echo "[setup] Installing librosa 0.11.0 and its audio dependencies ..."
"$PYTHON_EXE" -m pip install --upgrade pip
"$PYTHON_EXE" -m pip install "librosa==0.11.0"

echo
echo "[setup] Smart audio analysis is ready."
echo "Set PYTHON before running MotionScore:"
echo "  export PYTHON=\"$PYTHON_EXE\""
echo
echo "For optional --mode notes transcription, also run scripts/setup-basic-pitch.sh."
