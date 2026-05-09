import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type { AccountState, DecisionContext, ExecutionPlan, PositionState } from "../domain/types.js";
import { LiveBroker } from "./brokers.js";

const testConfig: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  logLevel: "silent",
  tradingMode: "live",
  symbol: "BTCUSDT",
  binance: {
    restBaseUrl: "https://example.com",
    wsBaseUrl: "wss://example.com/stream",
    apiKey: "key",
    apiSecret: "secret"
  },
  postgresUrl: "postgres://postgres:postgres@localhost:5432/trader",
  redisUrl: "redis://localhost:6379",
  telegram: {},
  feeds: {
    news: [],
    macro: []
  },
  onchainBaseUrl: "https://example.com/api",
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
};

const accountState: AccountState = {
  equity: 10_000,
  walletBalance: 10_000,
  availableBalance: 9_000,
  dailyPnl: 0,
  weeklyDrawdown: 0,
  consecutiveLosses: 0,
  openOrders: 0,
  updatedAt: 1
};

const context = (): DecisionContext => ({
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
    openInterest: 100,
    openInterestChangePct1m: 0.5,
    topTraderLongShortRatio: 1.1,
    volume1m: 10,
    priceChangePct1m: 0.1,
    priceChangePct5m: 0.2,
    priceChangePct15m: 0.3,
    priceChangePct1h: 0.4,
    intradayHigh: 101_000,
    intradayLow: 99_000,
    distanceFromIntradayHighPct: 1,
    distanceFromIntradayLowPct: 1,
    emaFast: 100_050,
    emaMedium: 99_950,
    trendStrengthPct: 0.2,
    volumeAcceleration: 1.1,
    timestamp: Date.now()
  },
  derivatives_snapshot: {
    funding_rate: 0.0001,
    next_funding_time: Date.now() + 60_000,
    open_interest: 100,
    open_interest_change_pct_1m: 0.5,
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
  account_state: accountState,
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
    momentum_score: 0.2,
    key_levels: {
      intraday_high: 101_000,
      intraday_low: 99_000
    },
    notes: ["test"]
  },
  trigger: {
    reason: "minute_recheck",
    priority: 0,
    details: "test",
    triggeredAt: Date.now()
  }
});

const longPlan: ExecutionPlan = {
  action: "LONG",
  side: "BUY",
  entryType: "MARKET",
  leverage: 2,
  quantity: 0.02,
  notionalUsd: 2_000,
  entryPrice: 100_000,
  stopLoss: 99_000,
  tp1: 101_500,
  tp2: 103_000,
  breakEvenTriggerR: 1,
  trailingTriggerR: 2,
  trailingOffset: 1_000,
  initialRiskPerUnit: 1_000,
  maxHoldUntil: Date.now() + 60_000,
  confidence: 0.8,
  setupType: "breakout",
  regimeAtEntry: "trend_up",
  entryReason: "Test entry",
  reasoningSummary: "Test entry",
  invalidationPrice: 99_000
};

const reducePlan: ExecutionPlan = {
  ...longPlan,
  action: "REDUCE",
  side: "SELL",
  quantity: 0.01,
  notionalUsd: 1_000,
  entryReason: "Reduce risk",
  reasoningSummary: "Reduce risk"
};

const closePlan: ExecutionPlan = {
  ...longPlan,
  action: "CLOSE",
  side: "SELL",
  entryReason: "Close trade",
  reasoningSummary: "Close trade"
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn()
} as unknown as Logger;

const longPositionState: PositionState = {
  side: "long",
  quantity: 0.02,
  entryPrice: 100_000,
  markPrice: 100_000,
  leverage: 2,
  unrealizedPnl: 0,
  realizedPnl: 0
};

const partialPositionState: PositionState = {
  ...longPositionState,
  quantity: 0.01
};

const flatPositionState: PositionState = {
  side: "flat",
  quantity: 0,
  entryPrice: 0,
  markPrice: 0,
  leverage: 1,
  unrealizedPnl: 0,
  realizedPnl: 0
};

describe("LiveBroker", () => {
  it("recreates protective orders after a partial reduce", async () => {
    const createOrder = vi
      .fn()
      .mockResolvedValueOnce({ orderId: "entry" })
      .mockResolvedValueOnce({ orderId: "stop-entry" })
      .mockResolvedValueOnce({ orderId: "tp-entry" })
      .mockResolvedValueOnce({ orderId: "reduce" })
      .mockResolvedValueOnce({ orderId: "stop-reduce" })
      .mockResolvedValueOnce({ orderId: "tp-reduce" });
    const client = {
      changeLeverage: vi.fn().mockResolvedValue(undefined),
      createOrder,
      cancelAllOrders: vi.fn().mockResolvedValue(undefined),
      getBalanceState: vi.fn().mockResolvedValue(accountState),
      getPositionState: vi.fn().mockResolvedValueOnce(longPositionState).mockResolvedValueOnce(partialPositionState)
    } as const;

    const broker = new LiveBroker(testConfig, client as never, logger);

    await broker.execute(longPlan, context());
    const result = await broker.execute(
      reducePlan,
      {
        ...context(),
        position_state: {
          ...partialPositionState,
          sourceTradeId: "trade-1"
        }
      }
    );

    expect(client.cancelAllOrders).toHaveBeenCalledWith(testConfig.symbol);
    expect(createOrder).toHaveBeenCalledTimes(6);
    expect(createOrder).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        side: "SELL",
        type: "STOP_MARKET",
        stopPrice: longPlan.stopLoss,
        quantity: partialPositionState.quantity,
        reduceOnly: true
      })
    );
    expect(createOrder).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({
        side: "SELL",
        type: "TAKE_PROFIT_MARKET",
        stopPrice: longPlan.tp2,
        quantity: partialPositionState.quantity,
        reduceOnly: true
      })
    );
    expect(result.tradeRecord?.status).toBe("partial");
    expect(result.tradeRecord?.remainingQuantity).toBe(partialPositionState.quantity);
  });

  it("does not recreate protective orders after a full close", async () => {
    const createOrder = vi
      .fn()
      .mockResolvedValueOnce({ orderId: "entry" })
      .mockResolvedValueOnce({ orderId: "stop-entry" })
      .mockResolvedValueOnce({ orderId: "tp-entry" })
      .mockResolvedValueOnce({ orderId: "close" });
    const client = {
      changeLeverage: vi.fn().mockResolvedValue(undefined),
      createOrder,
      cancelAllOrders: vi.fn().mockResolvedValue(undefined),
      getBalanceState: vi.fn().mockResolvedValue(accountState),
      getPositionState: vi.fn().mockResolvedValueOnce(longPositionState).mockResolvedValueOnce(flatPositionState)
    } as const;

    const broker = new LiveBroker(testConfig, client as never, logger);

    await broker.execute(longPlan, context());
    const result = await broker.execute(
      {
        ...closePlan,
        quantity: longPositionState.quantity
      },
      {
        ...context(),
        position_state: {
          ...longPositionState,
          sourceTradeId: "trade-2"
        }
      }
    );

    expect(createOrder).toHaveBeenCalledTimes(4);
    expect(result.tradeRecord?.status).toBe("closed");
  });
});
