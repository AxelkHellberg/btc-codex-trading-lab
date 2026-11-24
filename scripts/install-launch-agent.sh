#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_TEMPLATE="$ROOT/ops/launchd/com.btc-codex-trading-lab.plist.template"
PLIST_DST="$HOME/Library/LaunchAgents/com.btc-codex-trading-lab.plist"
LABEL="com.btc-codex-trading-lab"
NODE_BIN="$(command -v node)"
STDOUT_PATH="$ROOT/logs/launchd.out.log"
STDERR_PATH="$ROOT/logs/launchd.err.log"

mkdir -p "$ROOT/logs" "$HOME/Library/LaunchAgents"
npm run build >/dev/null
"$NODE_BIN" "$ROOT/scripts/render-launch-agent.mjs" \
  "$PLIST_TEMPLATE" "$PLIST_DST" "$LABEL" "$NODE_BIN" \
  "$ROOT" "$HOME" "$STDOUT_PATH" "$STDERR_PATH"
launchctl bootout "gui/$(id -u)" "$PLIST_DST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "installed: $PLIST_DST"
