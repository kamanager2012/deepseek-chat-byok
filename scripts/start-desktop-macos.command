#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$DIR/scripts/start-desktop.sh" ]; then
  exec bash "$DIR/scripts/start-desktop.sh"
else
  exec bash "$DIR/start-desktop.sh"
fi
