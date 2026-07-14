#!/usr/bin/env bash
#
# Idempotently create/refresh the local test virtualenv (Option A).
#
# Creates ``.venv`` at the repo root and installs the backend test dependencies
# (``requirements-test.txt``: Home Assistant + pytest). Safe to run repeatedly --
# it reuses an existing ``.venv`` and just re-syncs the dependencies.
#
# After this, run the suite with:
#   PYTHON=.venv/bin/python scripts/run_tests.sh
#
# Config (env vars):
#   PYTHON_BIN   interpreter used to create the venv   (default: python3)
#   VENV_DIR     virtualenv location                   (default: .venv)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV_DIR="${VENV_DIR:-.venv}"
VENV_PY="$VENV_DIR/bin/python"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "error: interpreter '$PYTHON_BIN' not found (set PYTHON_BIN=...)." >&2
  exit 2
fi

# Home Assistant 2026.7.x requires Python >=3.14.2.
if ! "$PYTHON_BIN" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 14, 2) else 1)'; then
  echo "error: '$PYTHON_BIN' is $("$PYTHON_BIN" -V 2>&1 | awk '{print $2}'); Home Assistant needs Python >=3.14.2." >&2
  echo "Point PYTHON_BIN at a newer interpreter." >&2
  exit 2
fi

if [ ! -x "$VENV_PY" ]; then
  echo "Creating virtualenv at $VENV_DIR ..."
  "$PYTHON_BIN" -m venv "$VENV_DIR"
else
  echo "Reusing existing virtualenv at $VENV_DIR."
fi

echo "Upgrading pip ..."
"$VENV_PY" -m pip install --quiet --upgrade pip

echo "Installing test dependencies from requirements-test.txt ..."
"$VENV_PY" -m pip install --quiet -r requirements-test.txt

echo
echo "Done. Home Assistant $("$VENV_PY" -c 'from homeassistant.const import __version__; print(__version__)') ready in $VENV_DIR."
echo "Run the suite with:"
echo "    PYTHON=$VENV_PY scripts/run_tests.sh"
