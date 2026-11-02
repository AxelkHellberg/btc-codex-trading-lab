#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"

mkdir -p logs run

NODE="$(command -v node)"
NODE="$("$NODE" -p 'process.execPath')"
HELPER="$ROOT/scripts/daemon-process.mjs"

if OLD_PID="$("$NODE" "$HELPER" verify run/app.pid)"; then
  echo "app already running with pid $OLD_PID"
  exit 0
fi
"$NODE" "$HELPER" stop run/caffeinate.pid

docker compose up -d postgres redis >/dev/null
npm run build >/dev/null

nohup "$NODE" "$ROOT/dist/index.js" >> logs/app.log 2>&1 &
APP_PID=$!
if ! "$NODE" "$HELPER" record run/app.pid app "$APP_PID" "$NODE"; then
  kill "$APP_PID" >/dev/null 2>&1 || true
  exit 1
fi

nohup /usr/bin/caffeinate -im -w "$APP_PID" >/dev/null 2>&1 &
CAFFEINATE_PID=$!
if ! "$NODE" "$HELPER" record run/caffeinate.pid caffeinate "$CAFFEINATE_PID" /usr/bin/caffeinate "$APP_PID"; then
  "$NODE" "$HELPER" stop run/app.pid
  exit 1
fi

echo "app pid: $APP_PID"
echo "caffeinate pid: $CAFFEINATE_PID"
echo "logs: $ROOT/logs/app.log"
