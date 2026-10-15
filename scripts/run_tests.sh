#!/usr/bin/env bash
#
# Run the Python unit test suite one process per file, JOBS files at a time.
#
# Each file runs in a fresh interpreter for independent results and parallel
# execution. The shared tests/conftest.py also isolates module imports when the
# suite runs together with pytest tests/.
#
# Parallelism: files run JOBS at a time (default: $(nproc)), each still in its
# own interpreter. Every file's output is captured separately, and once all of
# them have finished the PASS/FAIL lines are printed in input order, followed
# by the summary. JOBS=1 runs the files one after another.
#
# Requirements: a Python interpreter with ``homeassistant`` and ``pytest``
# installed. The host Python typically does NOT have Home Assistant -- create a
# venv from requirements-test.txt (CI does exactly this) or run inside the HA
# dev container. Override the interpreter with the PYTHON env var.
#
# Usage:
#   scripts/run_tests.sh                          # run every tests/test_*.py
#   scripts/run_tests.sh tests/test_schedule.py   # run specific files
#   JOBS=1 scripts/run_tests.sh                   # run serially
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

jobs_max="${JOBS:-$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)}"
if ! [[ "$jobs_max" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: JOBS must be a positive integer, got '$jobs_max'" >&2
  exit 2
fi
out_dir="$(mktemp -d)"
trap 'rm -rf "$out_dir"' EXIT
# Background jobs ignore SIGINT in a script, so stop them and their pytest
# children explicitly.
trap 'for j in $(jobs -p); do pkill -P "$j"; kill "$j"; done 2>/dev/null; exit 130' INT TERM

# Run each file in the background, at most $jobs_max at once; file i writes its
# output to $out_dir/i.out and its exit code to $out_dir/i.rc.
for i in "${!files[@]}"; do
  while [ "$(jobs -rp | wc -l)" -ge "$jobs_max" ]; do wait -n; done
  (
    "$PY" -m pytest -p no:cacheprovider -q "${files[$i]}" >"$out_dir/$i.out" 2>&1
    echo $? >"$out_dir/$i.rc"
  ) &
done
wait

pass_files=0
fail_files=0
failed=()
for i in "${!files[@]}"; do
  f="${files[$i]}"
  out_file="$out_dir/$i.out"
  # A file killed before writing its exit code counts as failed.
  if [ "$(cat "$out_dir/$i.rc" 2>/dev/null)" = 0 ]; then
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
