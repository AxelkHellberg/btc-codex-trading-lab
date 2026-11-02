# BTC Codex Trading Lab

Safety-first BTC futures research platform that combines:

- live market, news, macro, and on-chain ingestion
- Codex-driven directional signals
- deterministic execution planning
- hard risk controls that can veto every trade
- paper and live broker paths behind the same orchestration layer

This repository is positioned as an AI systems and backend engineering project, not as a promise of profitable trading performance.

## Why this project exists

The goal is to demonstrate how to build a production-shaped decision system around a large model without giving the model direct authority over risk, sizing, or execution. The AI layer proposes a thesis. The planner, risk engine, and broker lifecycle stay deterministic and auditable.

That split is the main engineering idea behind the repo.

## What it demonstrates

- Event-driven TypeScript backend architecture
- LLM integration with strict JSON schemas and fallback execution paths
- Risk-gated orchestration for safety-critical actions
- Stateful position lifecycle management with partial take profit, break-even, and trailing logic
- Dual persistence model with Postgres history and Redis hot state
- Operational scripts for local development and VM deployment
- Automated test coverage for planner, risk engine, broker lifecycle, and event detection

## Architecture

Core services:

- `market-ingestor`: Binance Futures market and derivatives data
- `news-ingestor`: crypto and macro RSS aggregation
- `onchain-ingestor`: BTC mempool and chain health context
- `event-detector`: event-driven trigger generation with 1-minute fallback
- `codex-decision-worker`: converts context into a validated `StrategySignal`
- `strategy-planner`: converts a signal into a deterministic `ExecutionPlan`
- `risk-engine`: validates exposure, regime alignment, risk/reward, and guardrails
- `execution-engine`: executes through paper or live brokers and persists outcomes
- `state-store`: Postgres + Redis backing for history and runtime state
- `ops-notifier`: Telegram notifications for operational visibility

Runtime flow:

1. Ingest market, news, macro, and on-chain context
2. Trigger evaluation on events or scheduled recheck
3. Ask Codex for a directional thesis only
4. Build a deterministic execution plan
5. Run the plan through the risk engine
6. Execute only if the plan clears all hard checks
7. Persist decisions, trade lifecycle, and account state

## Stack

- Node.js 22
- TypeScript
- Fastify
- PostgreSQL
- Redis
- OpenAI Codex SDK + CLI fallback
- Binance Futures REST/WebSocket
- Vitest
- Docker Compose

## Safety model

- The model cannot bypass the risk engine
- The model does not control final leverage, size, stop placement, or take-profit placement
- Paper mode and live mode share the same orchestration path
- Every decision is persisted with context, rationale, and approval outcome
- The system defaults to paper trading and should be treated as experimental research software

## Local development

1. Copy `.env.example` to `.env`
2. Fill the required credentials
3. Authenticate Codex:
   - `npx @openai/codex login --device-auth`
4. Install dependencies:
   - `npm install`
5. Start local infrastructure:
   - `docker compose up -d postgres redis`
6. Start the app:
   - `npm run dev`

### Paper-first startup

Keep `TRADING_MODE=paper` while validating a new environment. Before relying on the running service, run:

```bash
npm run doctor
```

The doctor output reports connectivity for PostgreSQL, Redis, the local HTTP server, and Binance, as well as whether Binance and Telegram credentials are present. Confirm `trading_mode: "paper"` and the expected symbol before sending a manual `POST /trigger` or running the paper script.

### Live mode

`./scripts/run-live.sh` sets `TRADING_MODE=live` for that process; it does not configure or validate your account for you. Use it only after paper-mode validation and after setting both `BINANCE_API_KEY` and `BINANCE_API_SECRET` in a local, uncommitted `.env` file. Review the risk settings in the same file—especially `RISK_PER_TRADE`, `MAX_LEVERAGE`, `MAX_DAILY_LOSS`, `MAX_WEEKLY_DRAWDOWN`, `MAX_OPEN_POSITIONS`, and `COOLDOWN_MINUTES`—before starting the live path.

Useful commands:

- `npm test`
- `npm run build`
- `npm run doctor`
- `npm run backtest`
- `./scripts/bootstrap.sh`
- `./scripts/run-paper.sh`
- `./scripts/run-live.sh`

## Operations

macOS background run:

- `./scripts/run-daemon.sh`
- stop with `./scripts/stop-daemon.sh`

macOS `launchd` install:

- `./scripts/install-launch-agent.sh`
- remove with `./scripts/uninstall-launch-agent.sh`

Linux VM template:

- `ops/systemd/btc-codex-trader.service`

## HTTP endpoints

- `GET /healthz`
- `GET /status`
- `POST /trigger`

## CI

GitHub Actions runs:

- `npm ci`
- `npm run build`
- `npm test`

## Important caveats

- This is not financial advice
- This is not high-frequency trading infrastructure
- The live execution path is more sensitive than the paper path and should be treated carefully
- No public performance claims should be made without long paper-trading evidence and explicit assumptions

## Portfolio positioning

This repo is strongest as a secondary public project for roles that value:

- AI product engineering
- backend systems
- mobile-adjacent platform work
- orchestration around LLMs

It is weaker as a primary repo for pure React Native, iOS, or Android roles because the delivered artifact is backend-heavy rather than client-heavy.

### Live order-count snapshots

Live account refreshes query both regular and conditional open orders for the
configured symbol. A failed, malformed, duplicate-ID, or wrong-symbol order
response rejects the refresh rather than publishing an invented zero. The count
includes protective orders and is scoped to that symbol, not other instruments
in the account. Each refresh adds two signed read requests; event coalescing and
rate-limit scheduling remain separate work (#58). These REST reads form a
best-effort snapshot rather than an atomic view of balances and orders. They do
not add an exchange-side limit or guarantee that order state remains unchanged
between risk approval and submission.

Endpoint contracts: [regular open orders](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Current-All-Open-Orders)
and [conditional open orders](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Current-All-Algo-Open-Orders).
