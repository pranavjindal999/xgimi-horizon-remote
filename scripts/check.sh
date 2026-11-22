#!/usr/bin/env bash
# Confirm the tools, the .env, and that ADB can see a device.
# Does not change projector settings.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0
say() { printf '%s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
ok() { printf 'ok    %s\n' "$1"; }

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
  ok ".env is present"
else
  bad ".env is missing. Run ./scripts/install.sh"
fi

if command -v node >/dev/null 2>&1; then
  ok "node $(node -v)"
else
  bad "node is not installed"
fi

if command -v adb >/dev/null 2>&1; then
  ok "adb $(adb version | head -n 1)"
else
  bad "adb is not installed"
fi

if [[ -n "${ADB_VENDOR_KEYS:-}" && ! -f "${ADB_VENDOR_KEYS}" ]]; then
  bad "ADB_VENDOR_KEYS is set but the file does not exist: ${ADB_VENDOR_KEYS}"
elif [[ -n "${ADB_VENDOR_KEYS:-}" ]]; then
  ok "ADB key file exists"
elif [[ -f "${HOME:-}/.android/adbkey" ]]; then
  ok "using ${HOME}/.android/adbkey"
else
  say "note  no ADB key file found yet. The first adb connection may need you to accept the prompt on the projector."
fi

if [[ -z "${XGIMI_HOST:-}" && -z "${XGIMI_MAC:-}" ]]; then
  say "note  XGIMI_HOST and XGIMI_MAC are empty. The server will use the only device in 'adb devices', if there is exactly one."
fi

if command -v adb >/dev/null 2>&1; then
  adb start-server >/dev/null
  if [[ -n "${XGIMI_HOST:-}" ]]; then
    adb connect "${XGIMI_HOST}" || bad "adb connect ${XGIMI_HOST} failed"
  fi
  say "adb devices:"
  adb devices -l || bad "adb devices failed"
fi

PORT="${PORT:-8095}"
if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  ok "remote is answering on port ${PORT}"
else
  say "note  nothing is answering on port ${PORT} yet. Start it with ./scripts/run.sh"
fi

exit "$fail"
