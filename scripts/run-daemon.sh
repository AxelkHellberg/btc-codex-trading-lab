#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p logs run

if [ -f run/app.pid ]; then
  OLD_PID="$(cat run/app.pid)"
  if kill -0 "$OLD_PID" >/dev/null 2>&1; then
    node scripts/wait-for-daemon.mjs "$OLD_PID"
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

APP_PID=""
CAFFEINATE_PID=""
cleanup_failed_start() {
  STATUS=$?
  if [ "$STATUS" -ne 0 ]; then
    # Only these new children and their matching files belong to this attempt.
    for CHILD in "$APP_PID" "$CAFFEINATE_PID"; do
      if [ -n "$CHILD" ]; then
        kill "$CHILD" >/dev/null 2>&1 || true
      fi
    done
    for ATTEMPT in {1..20}; do
      STILL_RUNNING=0
      for CHILD in "$APP_PID" "$CAFFEINATE_PID"; do
        if [ -n "$CHILD" ] && kill -0 "$CHILD" >/dev/null 2>&1; then
          STILL_RUNNING=1
        fi
      done
      [ "$STILL_RUNNING" -eq 0 ] && break
      sleep 0.1
    done
    for CHILD in "$APP_PID" "$CAFFEINATE_PID"; do
      if [ -n "$CHILD" ]; then
        kill -KILL "$CHILD" >/dev/null 2>&1 || true
        wait "$CHILD" >/dev/null 2>&1 || true
      fi
    done
    if [ -n "$APP_PID" ] && [ "$(cat run/app.pid 2>/dev/null)" = "$APP_PID" ]; then
      rm -f run/app.pid
    fi
    if [ -n "$CAFFEINATE_PID" ] && [ "$(cat run/caffeinate.pid 2>/dev/null)" = "$CAFFEINATE_PID" ]; then
      rm -f run/caffeinate.pid
    fi
  fi
  exit "$STATUS"
}
trap cleanup_failed_start EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

nohup node dist/index.js >> logs/app.log 2>&1 &
APP_PID=$!
echo "$APP_PID" > run/app.pid

if command -v caffeinate >/dev/null 2>&1; then
  nohup caffeinate -im -w "$APP_PID" >/dev/null 2>&1 &
  CAFFEINATE_PID=$!
  echo "$CAFFEINATE_PID" > run/caffeinate.pid
fi

node scripts/wait-for-daemon.mjs "$APP_PID"
trap - EXIT INT TERM

echo "app pid: $APP_PID"
if [ -n "$CAFFEINATE_PID" ]; then
  echo "caffeinate pid: $CAFFEINATE_PID"
fi
echo "logs: $ROOT/logs/app.log"
