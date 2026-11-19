#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_DIR="$ROOT_DIR/assessment/python"
VENV_DIR="$PYTHON_DIR/.venv"
BUILD_VENV_DIR="$PYTHON_DIR/.venv.build.$$"
OLD_VENV_DIR="${TMPDIR:-/tmp}/ai-student-assessment-python-venv-${UID:-user}-$$"

cleanup() {
  rm -rf "$BUILD_VENV_DIR" 2>/dev/null || true
}
trap cleanup EXIT

PYTHON_BIN="${PYTHON_BIN:-}"
if [[ -z "$PYTHON_BIN" ]]; then
  for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi

if [[ -z "$PYTHON_BIN" ]]; then
  echo "Python 3.11 or 3.12 is required." >&2
  exit 1
fi

PYTHON_VERSION="$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
case "$PYTHON_VERSION" in
  3.11|3.12|3.13) ;;
  *)
    echo "Unsupported Python version $PYTHON_VERSION from $PYTHON_BIN. Install Python 3.11 or 3.12, or set PYTHON_BIN." >&2
    exit 1
    ;;
esac

rm -rf "$BUILD_VENV_DIR" 2>/dev/null || true
"$PYTHON_BIN" -m venv "$BUILD_VENV_DIR"
"$BUILD_VENV_DIR/bin/python3" -m pip install -r "$PYTHON_DIR/requirements.txt"

if [[ -e "$VENV_DIR" ]]; then
  mv "$VENV_DIR" "$OLD_VENV_DIR"
fi
mv "$BUILD_VENV_DIR" "$VENV_DIR"

if [[ -e "$OLD_VENV_DIR" ]]; then
  rm -rf "$OLD_VENV_DIR" 2>/dev/null || {
    echo "Warning: could not completely remove old Python environment: $OLD_VENV_DIR" >&2
  }
fi

echo "Python bootstrap environment ready: $VENV_DIR"
