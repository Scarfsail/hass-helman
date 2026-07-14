#!/usr/bin/env bash
#
# Run the Python unit test suite inside the Home Assistant dev container.
#
# The host Python has no Home Assistant, so the tests can only run in the HA dev
# container. This copies the integration + tests + runner into a scratch dir in
# the container and invokes scripts/run_tests.sh there.
#
# Config (env vars):
#   HELMAN_TEST_CONTAINER   docker container name/id   (default: bold_gagarin)
#   HELMAN_TEST_DIR         scratch dir in container    (default: /tmp/helman_test)
#
# Usage:
#   scripts/run_tests_in_container.sh                          # whole suite
#   scripts/run_tests_in_container.sh tests/test_schedule.py   # specific files
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTAINER="${HELMAN_TEST_CONTAINER:-bold_gagarin}"
DIR="${HELMAN_TEST_DIR:-/tmp/helman_test}"

if ! docker inspect -f '{{.State.Running}}' "$CONTAINER" >/dev/null 2>&1; then
  echo "error: container '$CONTAINER' is not running." >&2
  echo "Set HELMAN_TEST_CONTAINER to your HA dev container name (see 'docker ps')." >&2
  exit 2
fi

echo "Syncing sources into $CONTAINER:$DIR ..."
docker exec "$CONTAINER" bash -lc "rm -rf '$DIR' && mkdir -p '$DIR/custom_components/helman' '$DIR/scripts'"
docker cp "$REPO_ROOT/custom_components/helman/." "$CONTAINER:$DIR/custom_components/helman/" >/dev/null
docker cp "$REPO_ROOT/tests"                       "$CONTAINER:$DIR/" >/dev/null
docker cp "$REPO_ROOT/scripts/run_tests.sh"        "$CONTAINER:$DIR/scripts/run_tests.sh" >/dev/null
# Drop stale bytecode so imports resolve against the freshly-copied sources.
docker exec "$CONTAINER" bash -lc "find '$DIR' -name __pycache__ -type d -prune -exec rm -rf {} + 2>/dev/null || true"

echo "Running suite in container ..."
docker exec "$CONTAINER" bash -lc "cd '$DIR' && bash scripts/run_tests.sh $*"
