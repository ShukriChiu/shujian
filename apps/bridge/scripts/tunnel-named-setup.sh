#!/usr/bin/env bash
# One-time setup for a persistent Cloudflare Tunnel (fixed hostname).
#
# Prerequisites:
#   - A domain on Cloudflare (e.g. example.com)
#   - cloudflared installed (brew install cloudflared)
#
# Usage:
#   TUNNEL_NAME=shujian-bridge HOSTNAME=bridge.example.com ./scripts/tunnel-named-setup.sh
set -euo pipefail

TUNNEL_NAME="${TUNNEL_NAME:-shujian-bridge}"
HOSTNAME="${HOSTNAME:-}"
PORT="${PORT:-8003}"
CF_DIR="${HOME}/.cloudflared"
CONFIG="${CF_DIR}/config.yml"

if [[ -z "$HOSTNAME" ]]; then
  echo "Set HOSTNAME to your public DNS name, e.g.:"
  echo "  HOSTNAME=bridge.yourdomain.com TUNNEL_NAME=shujian-bridge $0"
  exit 1
fi

mkdir -p "$CF_DIR"

if [[ ! -f "${CF_DIR}/cert.pem" ]]; then
  echo "Logging into Cloudflare (opens browser)…"
  cloudflared tunnel login
fi

if ! cloudflared tunnel list 2>/dev/null | grep -q "^${TUNNEL_NAME}[[:space:]]"; then
  echo "Creating tunnel: ${TUNNEL_NAME}"
  cloudflared tunnel create "$TUNNEL_NAME"
fi

TUNNEL_ID="$(cloudflared tunnel list | awk -v n="$TUNNEL_NAME" '$1 == n { print $2; exit }')"
if [[ -z "$TUNNEL_ID" ]]; then
  echo "Could not resolve tunnel id for ${TUNNEL_NAME}"
  exit 1
fi

CREDS="${CF_DIR}/${TUNNEL_ID}.json"
if [[ ! -f "$CREDS" ]]; then
  echo "Missing credentials file: ${CREDS}"
  exit 1
fi

echo "Routing DNS: ${HOSTNAME} → ${TUNNEL_NAME}"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"

cat >"$CONFIG" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CREDS}

ingress:
  - hostname: ${HOSTNAME}
    service: http://127.0.0.1:${PORT}
  - service: http_status:404
EOF

echo ""
echo "Wrote ${CONFIG}"
echo ""
echo "Start the tunnel (bridge must be on :${PORT}):"
echo "  cloudflared tunnel run ${TUNNEL_NAME}"
echo ""
echo "Dashboard bridge endpoint:"
echo "  https://${HOSTNAME}"
