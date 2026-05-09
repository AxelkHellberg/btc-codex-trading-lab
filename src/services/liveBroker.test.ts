import { describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import type { AppConfig } from "../config.js";
import type { AccountState, DecisionContext, ExecutionPlan, PositionState } from "../domain/types.js";
import { LiveBroker } from "./brokers.js";

const context = (): DecisionContext => ({
  market_snapshot: {
    symbol: "BTCUSDT",
    markPrice: 100_000,
    indexPrice: 100_000,
    lastPrice: 100_000,
    bestBid: 100_000,
    bestAsk: 100_001,
    spreadBps: 0.1,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 60_000,
    openInterest: 10,
    openInterestChangePct1m: 0.1,
    topTraderLongShortRatio: 1.1,
    volume1m: 1,
    priceChangePct1m: 0.1,
    priceChangePct5m: 0.3,
    priceChangePct15m: 0.6,
    priceChangePct1h: 1.1,
    intradayHigh: 100800,
    intradayLow: 99200,
    distanceFromIntradayHighPct: 0.7,
    distanceFromIntradayLowPct: 0.8,
    emaFast: 100120,
    emaMedium: 99970,
    trendStrengthPct: 0.15,
    volumeAcceleration: 1.2,
    timestamp: Date.now(),
    filters: {
      tickSize: 0.1,
      stepSize: 0.001,
      minQty: 0.001
    }
  },
  derivatives_snapshot: {
    funding_rate: 0.0001,
    next_funding_time: Date.now() + 60_000,
    open_interest: 10,
    open_interest_change_pct_1m: 0.1,
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
    momentum_score: 0.31,
    key_levels: {
      intraday_high: 100800,
      intraday_low: 99200
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

const liveConfig: AppConfig = {
  ...config,
  tradingMode: "live"
};

describe("LiveBroker", () => {
  it("recreates stop-loss and take-profit orders after a partial reduce", async () => {
    const accountState: AccountState = {
      equity: 10_000,
      walletBalance: 10_000,
      availableBalance: 9_000,
      dailyPnl: 0,
      weeklyDrawdown: 0,
      consecutiveLosses: 0,
      openOrders: 2,
      updatedAt: Date.now()
    };
    const openPosition: PositionState = {
      side: "long",
      quantity: 0.02,
      entryPrice: 100_000,
      markPrice: 100_200,
      leverage: 2,
      unrealizedPnl: 4,
      realizedPnl: 0,
      sourceTradeId: "trade-live-1"
    };
    const reducedPosition: PositionState = {
      ...openPosition,
      quantity: 0.01,
      realizedPnl: 15
    };
    const createOrder = vi
      .fn()
      .mockResolvedValueOnce({ orderId: "entry" })
      .mockResolvedValueOnce({ orderId: "stop" })
      .mockResolvedValueOnce({ orderId: "tp" })
      .mockResolvedValueOnce({ orderId: "reduce" })
      .mockResolvedValueOnce({ orderId: "stop-remaining" })
      .mockResolvedValueOnce({ orderId: "tp-remaining" });
    const client = {
      changeLeverage: vi.fn().mockResolvedValue(undefined),
      createOrder,
      cancelAllOrders: vi.fn().mockResolvedValue(undefined),
      getBalanceState: vi.fn().mockResolvedValue(accountState),
      getPositionState: vi
        .fn()
        .mockResolvedValueOnce(openPosition)
        .mockResolvedValueOnce(reducedPosition)
    };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const broker = new LiveBroker(
      liveConfig,
      client as never,
      logger as never
    );
    const openPlan: ExecutionPlan = {
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
      entryReason: "Test setup",
      reasoningSummary: "Test setup",
      invalidationPrice: 99_000
    };

    await broker.execute(openPlan, context());
    const reduceResult = await broker.execute(
      {
        ...openPlan,
        action: "REDUCE",
        side: "SELL",
        quantity: 0.01,
        notionalUsd: 1_000,
        reasoningSummary: "De-risk after partial take profit"
      },
      {
        ...context(),
        position_state: {
          ...openPosition,
          sourceTradeId: "trade-live-1"
        }
      }
    );

    expect(client.cancelAllOrders).toHaveBeenCalledWith("BTCUSDT");
    expect(createOrder).toHaveBeenCalledTimes(6);
    expect(createOrder).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        symbol: "BTCUSDT",
        side: "SELL",
        type: "STOP_MARKET",
        stopPrice: 99_000,
        quantity: 0.01,
        reduceOnly: true,
        newClientOrderId: "stop-trade-live-1-remaining"
      })
    );
    expect(createOrder).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({
        symbol: "BTCUSDT",
        side: "SELL",
        type: "TAKE_PROFIT_MARKET",
        stopPrice: 103_000,
        quantity: 0.01,
        reduceOnly: true,
        newClientOrderId: "tp-trade-live-1-remaining"
      })
    );
    expect(reduceResult.tradeRecord?.status).toBe("partial");
    expect(reduceResult.tradeRecord?.remainingQuantity).toBeCloseTo(0.01, 5);
  });
});
