import { describe, expect, it } from "vitest";

import { config } from "../config.js";
import type { DecisionContext, ExecutionPlan } from "../domain/types.js";
import { PaperBroker } from "./brokers.js";

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

describe("PaperBroker", () => {
  it("manages break-even, partial TP, and trailing stop on a long trade", async () => {
    const broker = new PaperBroker(config);
    const plan: ExecutionPlan = {
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

    const open = await broker.execute(plan, context());
    expect(open.accepted).toBe(true);
    expect(open.tradeRecord?.status).toBe("open");

    await broker.onMarketSnapshot?.({
      ...context().market_snapshot,
      markPrice: 101_050
    });
    expect(broker.getState().positionState.breakEvenArmed).toBe(true);
    expect(broker.getState().positionState.stopLoss).toBeGreaterThanOrEqual(open.positionState.entryPrice);

    const partial = await broker.onMarketSnapshot?.({
      ...context().market_snapshot,
      markPrice: 101_600
    });
    expect(partial?.accepted).toBe(true);
    expect(partial?.tradeRecord?.status).toBe("partial");
    expect(partial?.positionState.quantity).toBeCloseTo(0.01, 5);

    await broker.onMarketSnapshot?.({
      ...context().market_snapshot,
      markPrice: 102_200
    });
    expect(broker.getState().positionState.trailingActive).toBe(true);

    const close = await broker.onMarketSnapshot?.({
      ...context().market_snapshot,
      markPrice: 101_100
    });
    expect(close?.accepted).toBe(true);
    expect(close?.tradeRecord?.status).toBe("closed");
    expect(close?.tradeRecord?.exitReason).toBe("trailing_stop");
    expect(close?.positionState.side).toBe("flat");
  });
});
