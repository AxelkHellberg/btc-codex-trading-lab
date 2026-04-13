import { describe, expect, it } from "vitest";

import { config } from "../config.js";
import type { DecisionContext } from "../domain/types.js";
import { StrategyPlanner } from "./strategyPlanner.js";

const buildContext = (regime: DecisionContext["context_summary"]["regime"] = "trend_up"): DecisionContext => ({
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
    intradayHigh: 101000,
    intradayLow: 98000,
    distanceFromIntradayHighPct: 0.99,
    distanceFromIntradayLowPct: 2.04,
    emaFast: 100300,
    emaMedium: 99900,
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
    regime,
    trend_bias: regime === "trend_down" ? "bearish" : regime === "range" ? "neutral" : "bullish",
    catalyst_bias: "neutral",
    momentum_score: 0.64,
    key_levels: {
      intraday_high: 101000,
      intraday_low: 98000
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

describe("StrategyPlanner", () => {
  it("builds a deterministic execution plan for a bullish breakout", () => {
    const planner = new StrategyPlanner(config);
    const result = planner.plan(buildContext(), {
      bias: "LONG",
      confidence: 0.66,
      setup_type: "breakout",
      invalidation_price: 99_000,
      holding_horizon_minutes: 90,
      reasoning_summary: "Trend continuation above the EMA stack."
    });

    expect(result.plan?.entryPrice).toBe(100_000);
    expect(result.plan?.tp1).toBe(101_500);
    expect(result.plan?.tp2).toBe(103_000);
    expect(result.plan?.breakEvenTriggerR).toBe(1);
    expect(result.plan?.trailingTriggerR).toBe(2);
    expect(result.reasons).toEqual([]);
  });

  it("flags range entries that are not explicit reversions", () => {
    const planner = new StrategyPlanner(config);
    const result = planner.plan(buildContext("range"), {
      bias: "LONG",
      confidence: 0.7,
      setup_type: "continuation",
      invalidation_price: 99_200,
      holding_horizon_minutes: 60,
      reasoning_summary: "This should not pass the range filter."
    });

    expect(result.reasons).toContain("range regime requires explicit reversion setup");
  });

  it("allows explicit range reversions and reports only confidence when edge is weak", () => {
    const planner = new StrategyPlanner(config);
    const result = planner.plan(buildContext("range"), {
      bias: "SHORT",
      confidence: 0.29,
      setup_type: "range_reversion",
      invalidation_price: 100_900,
      holding_horizon_minutes: 45,
      reasoning_summary: "Fade the upper end of the range on weak momentum."
    });

    expect(result.reasons).not.toContain("range regime requires explicit reversion setup");
    expect(result.reasons).toContain("confidence below regime threshold");
  });

  it("approves a moderate-confidence range reversion once it clears the regime floor", () => {
    const planner = new StrategyPlanner(config);
    const result = planner.plan(buildContext("range"), {
      bias: "SHORT",
      confidence: 0.32,
      setup_type: "range_reversion",
      invalidation_price: 100_900,
      holding_horizon_minutes: 45,
      reasoning_summary: "Fade the upper end of the range on weak momentum."
    });

    expect(result.reasons).toEqual([]);
    expect(result.plan?.quantity).toBeGreaterThan(0);
  });
});
