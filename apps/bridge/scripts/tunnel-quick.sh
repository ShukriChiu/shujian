#!/usr/bin/env bash
# Ephemeral Cloudflare Tunnel → local cursor-bridge (:8003).
# URL changes every run. Good for testing before setting up a named tunnel.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8003}"
LOG_DIR="${HOME}/.shujian/logs"
LOG_FILE="${LOG_DIR}/cloudflared-quick.log"

mkdir -p "$LOG_DIR"

if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "cursor-bridge is not running on :${PORT}."
  echo "Start it first:  just dev-bridge"
  exit 1
fi

echo "Starting quick tunnel → http://127.0.0.1:${PORT}"
echo "Log: ${LOG_FILE}"
echo ""
echo "Paste the https://….trycloudflare.com URL into dashboard:"
echo "  https://shujian-dashboard.pages.dev/settings/bridges"
echo ""

exec cloudflared tunnel --url "http://127.0.0.1:${PORT}" 2>&1 | tee "$LOG_FILE"
