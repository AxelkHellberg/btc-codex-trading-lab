import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSdkState = vi.hoisted(() => {
  let nextThreadId = 0;

  return {
    runThreadIds: [] as number[],
    startThreadCalls: [] as unknown[],
    reset() {
      nextThreadId = 0;
      this.runThreadIds.length = 0;
      this.startThreadCalls.length = 0;
    },
    createThreadId() {
      nextThreadId += 1;
      return nextThreadId;
    }
  };
});

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    public startThread(options: unknown) {
      mockSdkState.startThreadCalls.push(options);
      const threadId = mockSdkState.createThreadId();

      return {
        run: vi.fn(async () => {
          mockSdkState.runThreadIds.push(threadId);
          return {
            finalResponse: JSON.stringify({
              bias: "FLAT",
              confidence: 0.42,
              setup_type: "range_reversion",
              invalidation_price: null,
              holding_horizon_minutes: 30,
              reasoning_summary: "Range conditions are mixed, so no trade is justified yet."
            })
          };
        })
      };
    }
  }
}));

import type { AppConfig } from "../config.js";
import type { DecisionContext } from "../domain/types.js";
import { CodexDecisionWorker } from "./codexDecisionWorker.js";

const createContext = (): DecisionContext => ({
  market_snapshot: {
    symbol: "BTCUSDT",
    markPrice: 100_000,
    indexPrice: 100_000,
    lastPrice: 100_000,
    bestBid: 99_999,
    bestAsk: 100_001,
    spreadBps: 0.2,
    fundingRate: 0.0001,
    nextFundingTime: 1_700_000_000_000,
    openInterest: 10,
    openInterestChangePct1m: 0.1,
    topTraderLongShortRatio: 1.1,
    volume1m: 1,
    priceChangePct1m: 0.05,
    priceChangePct5m: 0.1,
    priceChangePct15m: 0.2,
    priceChangePct1h: 0.4,
    intradayHigh: 100_500,
    intradayLow: 99_500,
    distanceFromIntradayHighPct: 0.5,
    distanceFromIntradayLowPct: 0.5,
    emaFast: 100_050,
    emaMedium: 99_980,
    trendStrengthPct: 0.12,
    volumeAcceleration: 1.1,
    timestamp: 1_700_000_000_000
  },
  derivatives_snapshot: {
    funding_rate: 0.0001,
    next_funding_time: 1_700_000_060_000,
    open_interest: 10,
    open_interest_change_pct_1m: 0.1,
    top_trader_long_short_ratio: 1.1
  },
  news_events: [],
  onchain_snapshot: {
    mempoolTxCount: 1000,
    fastestFee: 12,
    halfHourFee: 8,
    hourFee: 6,
    tipHeight: 100,
    difficultyAdjustment: 1.01,
    blockCadenceSeconds: 610,
    timestamp: 1_700_000_000_000
  },
  position_state: {
    side: "flat",
    quantity: 0,
    entryPrice: 0,
    markPrice: 100_000,
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
    updatedAt: 1_700_000_000_000
  },
  risk_state: {
    withinDailyLossLimit: true,
    withinWeeklyDrawdown: true,
    cooldownActive: false,
    reasons: []
  },
  context_summary: {
    regime: "range",
    trend_bias: "neutral",
    catalyst_bias: "neutral",
    momentum_score: 0.1,
    key_levels: {
      intraday_high: 100_500,
      intraday_low: 99_500
    },
    notes: ["No fresh catalyst."]
  },
  trigger: {
    reason: "minute_recheck",
    priority: 0,
    details: "scheduled one-minute recheck",
    triggeredAt: 1_700_000_000_000
  }
});

const createConfig = (): AppConfig => ({
  nodeEnv: "test",
  port: 3000,
  logLevel: "info",
  tradingMode: "paper",
  symbol: "BTCUSDT",
  binance: {
    restBaseUrl: "https://example.com",
    wsBaseUrl: "wss://example.com/stream",
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
    timeoutMs: 45_000,
    model: "gpt-5.1-codex",
    useCliFallback: false
  }
});

describe("CodexDecisionWorker", () => {
  beforeEach(() => {
    mockSdkState.reset();
  });

  it("starts a fresh SDK thread for each decision", async () => {
    const logger = { warn: vi.fn() } as unknown as Parameters<typeof CodexDecisionWorker>[1];
    const worker = new CodexDecisionWorker(createConfig(), logger);
    const first = createContext();
    const second = createContext();
    second.trigger.triggeredAt += 60_000;

    const firstDecision = await worker.decide(first);
    const secondDecision = await worker.decide(second);

    expect(firstDecision.invalidation_price).toBeUndefined();
    expect(secondDecision.invalidation_price).toBeUndefined();
    expect(mockSdkState.startThreadCalls).toHaveLength(2);
    expect(mockSdkState.runThreadIds).toEqual([1, 2]);
    expect((logger as { warn: ReturnType<typeof vi.fn> }).warn).not.toHaveBeenCalled();
  });
});
