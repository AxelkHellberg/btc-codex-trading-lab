#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"

node "$ROOT/scripts/daemon-process.mjs" stop run/caffeinate.pid
node "$ROOT/scripts/daemon-process.mjs" stop run/app.pid

echo "daemon stopped"
