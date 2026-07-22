#!/usr/bin/env bash
# setup-basic-pitch.sh
# Sets up a Python virtual environment with Basic Pitch for audio transcription.
# Run from the project root: ./scripts/setup-basic-pitch.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$PROJECT_ROOT/.venv"

echo "[setup] Creating Python virtual environment at $VENV_DIR ..."

if [ -d "$VENV_DIR" ]; then
    echo "[setup] .venv already exists, reusing it."
else
    python3 -m venv "$VENV_DIR"
fi

PIP="$VENV_DIR/bin/pip"
PYTHON_EXE="$VENV_DIR/bin/python"

echo "[setup] Upgrading pip and installing setuptools/wheel ..."
"$PYTHON_EXE" -m pip install --upgrade pip "setuptools<71" wheel

echo "[setup] Installing basic-pitch (ONNX backend) ..."
"$PIP" install "basic-pitch[onnx]==0.4.0" --no-deps

echo "[setup] Installing basic-pitch dependencies ..."
"$PIP" install librosa mir-eval numpy pretty-midi "resampy<0.4.3" scikit-learn scipy typing-extensions onnxruntime

echo ""
echo "[setup] Done! Basic Pitch is ready."
echo ""
echo "To use audio input, set the PYTHON env var before running:"
echo "  export PYTHON=\"$PYTHON_EXE\""
echo ""
echo "Or add to your .env file:"
echo "  PYTHON=$PYTHON_EXE"
