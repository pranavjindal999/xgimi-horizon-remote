#!/usr/bin/env bash
# Start the remote in the foreground, loading .env if it exists.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ ! -f web/dist/index.html ]]; then
  echo "The page is not built. Run ./scripts/install.sh first." >&2
  exit 1
fi

exec node src/server.mjs
