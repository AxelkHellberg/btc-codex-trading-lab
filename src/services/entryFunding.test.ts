import { describe, expect, it } from "vitest";
import { config } from "../config.js";
import type { AppConfig } from "../config.js";
import type { DecisionContext, StrategySignal } from "../domain/types.js";
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

const signal = (short: boolean): StrategySignal => ({
  bias: short ? "SHORT" : "LONG", confidence: 0.66, setup_type: "breakout",
  invalidation_price: short ? 101_000 : 99_000, holding_horizon_minutes: 90, reasoning_summary: "fixture"
});
const settings: AppConfig = { ...config, slippageBps: 100, takerFeeBps: 100 };
const contextFor = (short: boolean, availableBalance: number) => {
  const context = buildContext(short ? { regime: "trend_down", trend_bias: "bearish" } : undefined);
  context.account_state.availableBalance = availableBalance;
  return context;
};

describe("available entry funds", () => {
  it.each([false, true])("downsizes %s entries by margin plus fee at a conservative slippage fill", (short) => {
    const context = contextFor(short, 100);
    const planning = new StrategyPlanner(settings).plan(context, signal(short));
    expect(planning.reasons).toEqual([]);
    expect(planning.plan?.quantity).toBe(0.001);
    expect(new RiskEngine(settings).evaluate(context, planning).approved).toBe(true);
    // 0.002 BTC requires 103.02 USD at 2x after 1% slippage and a 1% entry fee.
    expect(200 * 1.01 * (1 / 2 + 0.01)).toBeCloseTo(103.02);
  });

  it.each([false, true])("preserves the equity sizing limits with sufficient %s funds", (short) => {
    const context = contextFor(short, 10_000);
    const planning = new StrategyPlanner(settings).plan(context, signal(short));
    expect(planning.plan?.quantity).toBe(0.024);
    expect(new RiskEngine(settings).evaluate(context, planning).approved).toBe(true);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])("rejects unusable available balance %s in both planner and direct risk evaluation", (available) => {
    const healthy = contextFor(false, 10_000);
    const planning = new StrategyPlanner(settings).plan(healthy, signal(false));
    const context = contextFor(false, available);
    const invalid = new StrategyPlanner(settings).plan(context, signal(false));
    expect(invalid.plan).toBeUndefined();
    expect(invalid.reasons).toContain("available balance must be finite and positive");
    const evaluation = new RiskEngine(settings).evaluate(context, planning);
    expect(evaluation.approved).toBe(false);
    expect(evaluation.reasons).toContain("available balance must be finite and positive");
  });

  it.each([false, true])("independently rejects an unfundable direct %s plan even if reported notional is understated", (short) => {
    const context = contextFor(short, 100);
    const planning = new StrategyPlanner(settings).plan(contextFor(short, 10_000), signal(short));
    planning.plan!.notionalUsd = 1;
    const evaluation = new RiskEngine(settings).evaluate(context, planning);
    expect(evaluation.approved).toBe(false);
    expect(evaluation.reasons).toContain("entry margin and fee reserve exceeds available balance");
  });

  it("uses the more expensive current mark when rechecking a supplied plan", () => {
    const context = contextFor(false, 100);
    const planning = new StrategyPlanner(settings).plan(context, signal(false));
    context.market_snapshot.markPrice = 1_000_000;
    expect(new RiskEngine(settings).evaluate(context, planning).approved).toBe(false);
  });

  it("rejects a downsized quantity below minQty and a notional below minNotional", () => {
    const context = contextFor(false, 1);
    const planner = new StrategyPlanner(settings);
    let planning = planner.plan(context, signal(false));
    expect(planning.reasons).toContain("calculated quantity is below exchange minimum");
    expect(new RiskEngine(settings).evaluate(context, planning).approved).toBe(false);
    context.account_state.availableBalance = 100;
    context.market_snapshot.filters!.minNotional = 200;
    planning = planner.plan(context, signal(false));
    expect(new RiskEngine(settings).evaluate(context, planning).reasons).toContain("notional is below exchange minimum");
  });

  it.each(["CLOSE", "REDUCE"] as const)("does not block %s when available balance is invalid", (bias) => {
    const context = contextFor(false, NaN);
    context.position_state = { ...context.position_state, side: "long", quantity: 0.01 };
    const planning = new StrategyPlanner(settings).plan(context, { ...signal(false), bias });
    expect(planning.plan?.quantity).toBeGreaterThan(0);
    expect(new RiskEngine(settings).evaluate(context, planning).approved).toBe(true);
  });

  it.each([0, NaN, Infinity, 100])("rejects an invalid or out-of-policy leverage %s in a direct plan", (leverage) => {
    const context = contextFor(false, 100);
    const planning = new StrategyPlanner(settings).plan(contextFor(false, 10_000), signal(false));
    planning.plan!.leverage = leverage;
    expect(new RiskEngine(settings).evaluate(context, planning).approved).toBe(false);
  });

  it("rejects invalid funding settings rather than treating their reserve as free", () => {
    for (const override of [{ takerFeeBps: NaN }, { slippageBps: Infinity }, { takerFeeBps: -1 }]) {
      const invalidSettings = { ...settings, ...override };
      const context = contextFor(false, 10_000);
      expect(new StrategyPlanner(invalidSettings).plan(context, signal(false)).plan).toBeUndefined();
      const planning = new StrategyPlanner(settings).plan(context, signal(false));
      expect(new RiskEngine(invalidSettings).evaluate(context, planning).approved).toBe(false);
    }
  });
});
