#!/usr/bin/env bash
#
# Run the Python unit test suite one file at a time, each in its own process.
#
# WHY per-file: many test modules install their own conflicting ``sys.modules``
# stubs at import time (some need the real ``homeassistant`` package present,
# others need it absent). Importing them all into a single ``pytest tests/``
# process causes cross-file pollution and spurious failures. Running each file
# in a fresh interpreter keeps them isolated. See tests/conftest.py.
#
# Requirements: a Python interpreter with ``homeassistant`` and ``pytest``
# installed. The host Python typically does NOT have Home Assistant -- create a
# venv from requirements-test.txt (CI does exactly this) or run inside the HA
# dev container. Override the interpreter with the PYTHON env var.
#
# Usage:
#   scripts/run_tests.sh                          # run every tests/test_*.py
#   scripts/run_tests.sh tests/test_schedule.py   # run specific files
#   PYTHON=/path/to/venv/bin/python scripts/run_tests.sh
#
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Interpreter: explicit PYTHON wins; otherwise prefer the repo's .venv (created
# by scripts/setup_test_venv.sh) and fall back to python3.
if [ -n "${PYTHON:-}" ]; then
  PY="$PYTHON"
elif [ -x "$REPO_ROOT/.venv/bin/python" ]; then
  PY="$REPO_ROOT/.venv/bin/python"
else
  PY="python3"
fi

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "error: interpreter '$PY' not found." >&2
  echo "Set PYTHON=... to a Python that has homeassistant + pytest." >&2
  exit 2
fi

if ! "$PY" -c 'import pytest, homeassistant' >/dev/null 2>&1; then
  echo "error: '$PY' cannot import both 'pytest' and 'homeassistant'." >&2
  echo >&2
  echo "These tests require Home Assistant. Create the test venv first:" >&2
  echo "    scripts/setup_test_venv.sh" >&2
  echo "then just run:" >&2
  echo "    scripts/run_tests.sh" >&2
  echo "(or point PYTHON=... at an interpreter that has homeassistant + pytest.)" >&2
  exit 2
fi

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  files=(tests/test_*.py)
fi

pass_files=0
fail_files=0
failed=()
out_file="$(mktemp)"
trap 'rm -f "$out_file"' EXIT

for f in "${files[@]}"; do
  if "$PY" -m pytest -p no:cacheprovider -q "$f" >"$out_file" 2>&1; then
    pass_files=$((pass_files + 1))
    printf '  \033[32mPASS\033[0m  %s  (%s)\n' "$(basename "$f")" "$(tail -1 "$out_file")"
  else
    fail_files=$((fail_files + 1))
    failed+=("$f")
    printf '  \033[31mFAIL\033[0m  %s  (%s)\n' "$(basename "$f")" "$(tail -1 "$out_file")"
    # Surface the failing detail for CI logs.
    sed -n '/=\{5,\} \(FAILURES\|ERRORS\) =\{5,\}/,$p' "$out_file" | head -60
  fi
done

echo
echo "=================================================================="
echo "test files: ${#files[@]}   passed: $pass_files   failed: $fail_files"
if [ "$fail_files" -ne 0 ]; then
  echo "failed files:"
  for f in "${failed[@]}"; do echo "  - $f"; done
  echo "=================================================================="
  exit 1
fi
echo "=================================================================="
