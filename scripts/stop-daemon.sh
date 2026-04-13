#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f run/caffeinate.pid ]; then
  CAFFEINATE_PID="$(cat run/caffeinate.pid)"
  kill "$CAFFEINATE_PID" >/dev/null 2>&1 || true
  rm -f run/caffeinate.pid
fi

if [ -f run/app.pid ]; then
  APP_PID="$(cat run/app.pid)"
  kill "$APP_PID" >/dev/null 2>&1 || true
  rm -f run/app.pid
fi

echo "daemon stopped"
