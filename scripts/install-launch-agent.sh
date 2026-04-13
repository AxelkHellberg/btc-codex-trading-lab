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
sed \
  -e "s|__LABEL__|$LABEL|g" \
  -e "s|__NODE_BIN__|$NODE_BIN|g" \
  -e "s|__WORKDIR__|$ROOT|g" \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__STDOUT__|$STDOUT_PATH|g" \
  -e "s|__STDERR__|$STDERR_PATH|g" \
  "$PLIST_TEMPLATE" > "$PLIST_DST"
launchctl bootout "gui/$(id -u)" "$PLIST_DST" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "installed: $PLIST_DST"
