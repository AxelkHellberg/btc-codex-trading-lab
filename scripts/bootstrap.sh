#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env ]; then
  cp .env.example .env
fi

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
docker compose up -d postgres redis
echo "Run 'npx @openai/codex login --device-auth' if Codex is not authenticated yet."
echo "Then start paper trading with: npm run dev"
