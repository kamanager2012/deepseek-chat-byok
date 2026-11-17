#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${PORT:-8787}"

if [[ ! -f "dist/index.html" ]]; then
  echo "[deepseek-chat-byok] dist/ not found; building production bundle..."
  pnpm build
fi

echo "[deepseek-chat-byok] Listening on 0.0.0.0:${PORT}"
if command -v hostname >/dev/null 2>&1; then
  for ip in $(hostname -I 2>/dev/null || true); do
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "  LAN URL: http://${ip}:${PORT}"
    fi
  done
fi
echo "  Note: Mobile browsers require HTTPS (reverse proxy / Tailscale) for Service Worker PWA installation."

exec node server.mjs --host 0.0.0.0 --port "$PORT"
