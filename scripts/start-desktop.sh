#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
URL="http://${HOST}:${PORT}"

if [[ ! -f "dist/index.html" ]]; then
  echo "[deepseek-chat-byok] dist/ not found; building production bundle..."
  pnpm build
fi

node server.mjs --host "$HOST" --port "$PORT" &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for _ in {1..40}; do
  if node -e "fetch('${URL}/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

echo "[deepseek-chat-byok] Ready at ${URL} (Ctrl+C to stop)"

open_desktop_window() {
  if [[ "${NO_OPEN:-0}" == "1" ]]; then
    return 0
  fi
  for bin in google-chrome chromium chromium-browser microsoft-edge; do
    if command -v "$bin" >/dev/null 2>&1; then
      "$bin" "--app=${URL}" >/dev/null 2>&1 &
      return 0
    fi
  done
  if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "--app=${URL}" >/dev/null 2>&1 &
    return 0
  fi
  if [[ -x "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ]]; then
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" "--app=${URL}" >/dev/null 2>&1 &
    return 0
  fi
  if command -v open >/dev/null 2>&1; then
    open "$URL"
    return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 &
    return 0
  fi
  return 0
}

open_desktop_window
wait "$SERVER_PID"
