#!/usr/bin/env bash
# Install the remote on this machine: dependencies, web build, and a .env file.
# Optional: sudo ./scripts/install.sh --service
#   installs a systemd unit that starts on boot.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SERVICE=0
if [[ "${1:-}" == "--service" ]]; then
  SERVICE=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: ./scripts/install.sh [--service]" >&2
  exit 1
fi

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing '$1'. $2" >&2
    exit 1
  fi
}

need node "Install Node.js 20 or newer from https://nodejs.org"
need npm "npm ships with Node.js."
need adb "Install Android platform-tools and make sure 'adb' is on PATH."

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20 or newer is required. This machine has $(node -v)." >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl was not found. HTTPS and phone install will stay off until it is installed." >&2
fi

echo "Installing server dependencies…"
npm install

echo "Installing and building the web page…"
npm install --prefix web
npm run build

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
  echo "Set XGIMI_HOST or XGIMI_MAC, and ADB_VENDOR_KEYS, before starting."
else
  echo ".env already exists. Left it unchanged."
fi

mkdir -p data cache/icons

if [[ "$SERVICE" -eq 1 ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Re-run with sudo to install the systemd service: sudo ./scripts/install.sh --service" >&2
    exit 1
  fi
  NODE_BIN="$(command -v node)"
  UNIT=/etc/systemd/system/xgimi-horizon-remote.service
  cat >"$UNIT" <<EOF
[Unit]
Description=LAN remote for an Android TV projector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ROOT/.env
ExecStart=$NODE_BIN $ROOT/src/server.mjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now xgimi-horizon-remote.service
  systemctl --no-pager --full status xgimi-horizon-remote.service || true
  echo "Service xgimi-horizon-remote is enabled."
else
  echo
  echo "Build finished."
  echo "Start it with:  ./scripts/run.sh"
  echo "Check the link: ./scripts/check.sh"
  echo "Run on boot:    sudo ./scripts/install.sh --service"
fi
