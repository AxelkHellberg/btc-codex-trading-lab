import { describe, expect, it } from "vitest";

import { config } from "../config.js";
import type { DecisionContext } from "../domain/types.js";
import { RiskEngine } from "./riskEngine.js";
import { StrategyPlanner } from "./strategyPlanner.js";

const buildContext = (overrides?: Partial<DecisionContext["context_summary"]>): DecisionContext => ({
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
    regime: "trend_up",
    trend_bias: "bullish",
    catalyst_bias: "neutral",
    momentum_score: 0.64,
    key_levels: {
      intraday_high: 101000,
      intraday_low: 98000
    },
    notes: ["test"],
    ...overrides
  },
  trigger: {
    reason: "market_breakout",
    priority: 3,
    details: "test",
    triggeredAt: Date.now()
  }
});

describe("RiskEngine", () => {
  it("approves a valid trend-aligned long plan", () => {
    const planner = new StrategyPlanner(config);
    const engine = new RiskEngine(config);
    const planning = planner.plan(buildContext(), {
      bias: "LONG",
      confidence: 0.62,
      setup_type: "breakout",
      invalidation_price: 99_000,
      holding_horizon_minutes: 90,
      reasoning_summary: "Momentum remains aligned with bullish regime."
    });
    const result = engine.evaluate(buildContext(), planning);

    expect(result.approved).toBe(true);
    expect(result.executionPlan?.quantity).toBeGreaterThan(0);
    expect(result.executionPlan?.tp1).toBeGreaterThan(result.executionPlan?.entryPrice ?? 0);
    expect(result.executionPlan?.tp2).toBeGreaterThan(result.executionPlan?.tp1 ?? 0);
  });

  it("rejects continuation entries in a range regime", () => {
    const context = buildContext({
      regime: "range",
      momentum_score: 0.08,
      trend_bias: "neutral"
    });
    const planner = new StrategyPlanner(config);
    const engine = new RiskEngine(config);
    const planning = planner.plan(context, {
      bias: "LONG",
      confidence: 0.7,
      setup_type: "continuation",
      invalidation_price: 99_100,
      holding_horizon_minutes: 60,
      reasoning_summary: "Trying to force continuation in a flat tape."
    });
    const result = engine.evaluate(context, planning);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("range regime requires explicit reversion setup");
  });

  it("rejects short continuation against an uptrend", () => {
    const planner = new StrategyPlanner(config);
    const engine = new RiskEngine(config);
    const planning = planner.plan(buildContext(), {
      bias: "SHORT",
      confidence: 0.8,
      setup_type: "continuation",
      invalidation_price: 100_900,
      holding_horizon_minutes: 45,
      reasoning_summary: "Countertrend continuation that should be blocked."
    });
    const result = engine.evaluate(buildContext(), planning);

    expect(result.approved).toBe(false);
    expect(result.reasons).toContain("regime misaligned for entry");
  });

  it("does not mislabel a valid range reversion as structurally invalid", () => {
    const context = buildContext({
      regime: "range",
      momentum_score: -0.08,
      trend_bias: "neutral"
    });
    const planner = new StrategyPlanner(config);
    const engine = new RiskEngine(config);
    const planning = planner.plan(context, {
      bias: "SHORT",
      confidence: 0.31,
      setup_type: "range_reversion",
      invalidation_price: 100_900,
      holding_horizon_minutes: 45,
      reasoning_summary: "Fade a weak move near the range high."
    });
    const result = engine.evaluate(context, planning);

    expect(result.approved).toBe(true);
    expect(result.reasons).not.toContain("range regime requires explicit reversion setup");
  });
});
