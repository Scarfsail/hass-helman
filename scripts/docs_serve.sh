#!/usr/bin/env bash
#
# Preview the documentation site locally with live reload.
#
#   scripts/docs_serve.sh            # http://127.0.0.1:8100/hass-helman/
#   PORT=8200 scripts/docs_serve.sh  # another port
#
# Installs the pinned MkDocs packages from docs/requirements.txt on first use.
# Port 8000 (MkDocs' default) is avoided because it is often taken locally.
set -euo pipefail

cd "$(dirname "$0")/.."
PYTHON="${PYTHON:-python3}"
PORT="${PORT:-8100}"

if ! "$PYTHON" -c "import mkdocs, material" 2>/dev/null; then
  "$PYTHON" -m pip install -r docs/requirements.txt
fi

export NO_MKDOCS_2_WARNING=1
exec "$PYTHON" -m mkdocs serve -a "127.0.0.1:${PORT}" "$@"
