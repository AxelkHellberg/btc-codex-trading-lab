import { EventEmitter } from "node:events";

import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import type { DecisionContext, StrategySignal } from "../domain/types.js";

const runMock = vi.fn();
const startThreadMock = vi.fn(() => ({ run: runMock }));
const spawnMock = vi.fn();
const mkdtempMock = vi.fn();
const writeFileMock = vi.fn();
const rmMock = vi.fn();

vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn().mockImplementation(() => ({
    startThread: startThreadMock
  }))
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: mkdtempMock,
  rm: rmMock,
  writeFile: writeFileMock
}));

const createChildProcess = () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn()
  };
  return child;
};

const buildSignal = (overrides: Partial<StrategySignal> = {}): StrategySignal => ({
  bias: "LONG",
  confidence: 0.72,
  setup_type: "breakout",
  invalidation_price: 99_100,
  holding_horizon_minutes: 90,
  reasoning_summary: "Momentum is aligned with the broader bullish intraday trend.",
  ...overrides
});

const buildConfig = (useCliFallback = true): AppConfig => ({
  nodeEnv: "test",
  port: 3000,
  logLevel: "silent",
  tradingMode: "paper",
  symbol: "BTCUSDT",
  binance: {
    restBaseUrl: "https://fapi.binance.com",
    wsBaseUrl: "wss://fstream.binance.com/stream",
    apiKey: "",
    apiSecret: ""
  },
  postgresUrl: "postgres://postgres:postgres@localhost:5432/trader",
  redisUrl: "redis://localhost:6379",
  telegram: {},
  feeds: {
    news: [],
    macro: []
  },
  onchainBaseUrl: "https://mempool.space/api",
  riskPolicy: {
    maxLeverage: 3,
    riskPerTrade: 0.005,
    maxDailyLoss: 0.02,
    maxWeeklyDrawdown: 0.05,
    maxOpenPositions: 1,
    cooldownMinutes: 60,
    minRiskReward: 1.5
  },
  slippageBps: 3,
  takerFeeBps: 4,
  paperStartingBalance: 10_000,
  codex: {
    timeoutMs: 1_000,
    model: "gpt-5.1-codex",
    useCliFallback
  }
});

const buildContext = (): DecisionContext => ({
  market_snapshot: {
    symbol: "BTCUSDT",
    markPrice: 100_000,
    indexPrice: 100_000,
    lastPrice: 100_000,
    bestBid: 99_999,
    bestAsk: 100_001,
    spreadBps: 0.2,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 60_000,
    openInterest: 500_000,
    openInterestChangePct1m: 0.2,
    topTraderLongShortRatio: 1.1,
    volume1m: 120,
    priceChangePct1m: 0.4,
    priceChangePct5m: 0.8,
    priceChangePct15m: 1.2,
    priceChangePct1h: 2.4,
    intradayHigh: 101_000,
    intradayLow: 98_000,
    distanceFromIntradayHighPct: 0.99,
    distanceFromIntradayLowPct: 2.04,
    emaFast: 100_300,
    emaMedium: 99_900,
    trendStrengthPct: 0.4,
    volumeAcceleration: 1.4,
    timestamp: Date.now(),
    filters: {
      tickSize: 0.1,
      stepSize: 0.001,
      minQty: 0.001,
      minNotional: 5
    }
  },
  derivatives_snapshot: {
    funding_rate: 0.0001,
    next_funding_time: Date.now() + 60_000,
    open_interest: 500_000,
    open_interest_change_pct_1m: 0.2,
    top_trader_long_short_ratio: 1.1
  },
  news_events: [],
  onchain_snapshot: null,
  position_state: {
    side: "flat",
    quantity: 0,
    entryPrice: 0,
    markPrice: 0,
    leverage: 1,
    unrealizedPnl: 0,
    realizedPnl: 0
  },
  account_state: {
    equity: 10_000,
    walletBalance: 10_000,
    availableBalance: 10_000,
    dailyPnl: 0,
    weeklyDrawdown: 0,
    consecutiveLosses: 0,
    openOrders: 0,
    updatedAt: Date.now()
  },
  risk_state: {
    withinDailyLossLimit: true,
    withinWeeklyDrawdown: true,
    cooldownActive: false,
    reasons: []
  },
  context_summary: {
    regime: "trend_up",
    trend_bias: "bullish",
    catalyst_bias: "neutral",
    momentum_score: 0.64,
    key_levels: {
      intraday_high: 101_000,
      intraday_low: 98_000
    },
    notes: ["test"]
  },
  trigger: {
    reason: "market_breakout",
    priority: 3,
    details: "test",
    triggeredAt: Date.now()
  }
});

const logger = {
  warn: vi.fn()
} as unknown as Logger;

const { CodexDecisionWorker } = await import("./codexDecisionWorker.js");

describe("CodexDecisionWorker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startThreadMock.mockReturnValue({ run: runMock });
    mkdtempMock.mockResolvedValue("/tmp/btc-codex-schema-123");
    writeFileMock.mockResolvedValue(undefined);
    rmMock.mockResolvedValue(undefined);
  });

  it("returns the SDK response when the primary path succeeds", async () => {
    runMock.mockResolvedValue({
      finalResponse: JSON.stringify(buildSignal())
    });

    const worker = new CodexDecisionWorker(buildConfig(), logger);
    await expect(worker.decide(buildContext())).resolves.toEqual(buildSignal());

    expect(spawnMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to codex CLI and cleans up the schema directory after SDK failure", async () => {
    runMock.mockRejectedValue(new Error("sdk unavailable"));
    const child = createChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          `${JSON.stringify({ type: "item.started" })}\n${JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: JSON.stringify(buildSignal({ bias: "SHORT", setup_type: "reversal" }))
            }
          })}\n`
        );
        child.emit("close", 0);
      });
      return child;
    });

    const worker = new CodexDecisionWorker(buildConfig(true), logger);
    await expect(worker.decide(buildContext())).resolves.toEqual(
      buildSignal({ bias: "SHORT", setup_type: "reversal" })
    );

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/btc-codex-schema-123/strategy-signal.schema.json",
      expect.any(String),
      "utf8"
    );
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith("/tmp/btc-codex-schema-123", {
      recursive: true,
      force: true
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("rethrows the SDK error when CLI fallback is disabled", async () => {
    const sdkError = new Error("sdk timeout");
    runMock.mockRejectedValue(sdkError);

    const worker = new CodexDecisionWorker(buildConfig(false), logger);
    await expect(worker.decide(buildContext())).rejects.toThrow("sdk timeout");

    expect(spawnMock).not.toHaveBeenCalled();
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("fails clearly when the CLI output never emits an agent_message", async () => {
    runMock.mockRejectedValue(new Error("sdk unavailable"));
    const child = createChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", `${JSON.stringify({ type: "item.completed", item: { type: "tool_call" } })}\n`);
        child.emit("close", 0);
      });
      return child;
    });

    const worker = new CodexDecisionWorker(buildConfig(true), logger);
    await expect(worker.decide(buildContext())).rejects.toThrow("No agent_message found in codex CLI output");

    expect(rmMock).toHaveBeenCalledWith("/tmp/btc-codex-schema-123", {
      recursive: true,
      force: true
    });
  });

  it("removes the temporary schema directory when codex CLI exits non-zero", async () => {
    runMock.mockRejectedValue(new Error("sdk unavailable"));
    const child = createChildProcess();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stderr.emit("data", "permission denied");
        child.emit("close", 1);
      });
      return child;
    });

    const worker = new CodexDecisionWorker(buildConfig(true), logger);
    await expect(worker.decide(buildContext())).rejects.toThrow("codex exec failed with code 1: permission denied");

    expect(rmMock).toHaveBeenCalledWith("/tmp/btc-codex-schema-123", {
      recursive: true,
      force: true
    });
  });
});
