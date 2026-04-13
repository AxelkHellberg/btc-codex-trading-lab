#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p logs run

if [ -f run/app.pid ]; then
  OLD_PID="$(cat run/app.pid)"
  if kill -0 "$OLD_PID" >/dev/null 2>&1; then
    echo "app already running with pid $OLD_PID"
    exit 0
  fi
  rm -f run/app.pid
fi

if [ -f run/caffeinate.pid ]; then
  OLD_CAFFEINATE_PID="$(cat run/caffeinate.pid)"
  if kill -0 "$OLD_CAFFEINATE_PID" >/dev/null 2>&1; then
    kill "$OLD_CAFFEINATE_PID" >/dev/null 2>&1 || true
  fi
  rm -f run/caffeinate.pid
fi

docker compose up -d postgres redis >/dev/null
npm run build >/dev/null

nohup node dist/index.js >> logs/app.log 2>&1 &
APP_PID=$!
echo "$APP_PID" > run/app.pid

nohup /usr/bin/caffeinate -im -w "$APP_PID" >/dev/null 2>&1 &
CAFFEINATE_PID=$!
echo "$CAFFEINATE_PID" > run/caffeinate.pid

echo "app pid: $APP_PID"
echo "caffeinate pid: $CAFFEINATE_PID"
echo "logs: $ROOT/logs/app.log"
