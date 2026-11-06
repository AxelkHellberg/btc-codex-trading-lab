import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { DecisionContext, ExecutionPlan } from "../domain/types.js";
import { PaperBroker } from "./brokers.js";
import { RuntimeState } from "./runtimeState.js";
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

const policy = { maxDailyLoss: 0.02, maxWeeklyDrawdown: 0.05, cooldownMinutes: 60 };
const start = (at = "2026-11-06T12:00:00Z") => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(at));
  return new PaperBroker({ ...config, paperStartingBalance: 10000, slippageBps: 0, takerFeeBps: 0 });
};
const plan: ExecutionPlan = {
  action: "LONG", side: "BUY", entryType: "MARKET", leverage: 2, quantity: 1,
  notionalUsd: 10000, entryPrice: 10000, confidence: 1, setupType: "breakout",
  regimeAtEntry: "trend_up", entryReason: "test", reasoningSummary: "test"
};
const markedContext = (price: number) => ({ ...context(), market_snapshot: { ...context().market_snapshot, markPrice: price } });
const realize = async (broker: PaperBroker, pnl: number) => {
  await broker.execute(plan, markedContext(10000));
  return broker.execute({ ...plan, action: "CLOSE", side: "SELL" }, markedContext(10000 + pnl));
};
const risk = (broker: PaperBroker) => {
  const runtime = new RuntimeState(10000); runtime.setAccount(broker.getState().accountState);
  return runtime.getRiskState(policy);
};

describe("paper calendar risk windows", () => {
  afterEach(() => vi.useRealTimers());
  it("keeps the loss budget fixed across multiple intraday losses", async () => {
    const broker = start(); await realize(broker, -198);
    expect(broker.getState().accountState.dailyLossReferenceBalance).toBe(10000);
    expect(risk(broker).withinDailyLossLimit).toBe(true);
    await realize(broker, -2);
    expect(risk(broker).withinDailyLossLimit).toBe(false);
  });
  it("does not expand the daily budget after an intraday gain", async () => {
    const broker = start(); await realize(broker, 1000); await realize(broker, -1200);
    expect(broker.getState().accountState.dailyPnl).toBe(-200);
    expect(broker.getState().accountState.dailyLossReferenceBalance).toBe(10000);
    expect(risk(broker).withinDailyLossLimit).toBe(false);
  });
  it("rolls realized PnL and its reference at UTC midnight, even while flat", async () => {
    const broker = start("2026-11-06T23:59:59Z"); await realize(broker, -200);
    expect(risk(broker).withinDailyLossLimit).toBe(false);
    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    const account = broker.getState().accountState;
    expect(account.dailyPnl).toBe(0); expect(account.dailyLossReferenceBalance).toBe(9800);
    expect(account.lastLossAt).toBeDefined(); expect(account.consecutiveLosses).toBe(1);
    expect(risk(broker).withinDailyLossLimit).toBe(true);
    await realize(broker, -196);
    expect(risk(broker).withinDailyLossLimit).toBe(false);
  });
  it("resets the weekly peak on Monday UTC without erasing a carried position", async () => {
    const broker = start("2026-11-08T23:59:00Z");
    await broker.execute(plan, markedContext(10000));
    await broker.onMarketSnapshot(markedContext(11000).market_snapshot);
    await broker.onMarketSnapshot(markedContext(10000).market_snapshot);
    expect(broker.getState().accountState.weeklyDrawdown).toBeCloseTo(1/11);
    const before = broker.getState().positionState;
    vi.setSystemTime(new Date("2026-11-09T00:00:00Z"));
    expect(broker.getState().accountState.weeklyDrawdown).toBe(0);
    expect(broker.getState().accountState.weeklyPeakEquity).toBe(10000);
    expect(broker.getState().positionState).toEqual(before);
    await broker.onMarketSnapshot(markedContext(9500).market_snapshot);
    expect(broker.getState().accountState.weeklyDrawdown).toBeCloseTo(0.05);
    expect(risk(broker).withinWeeklyDrawdown).toBe(false);
  });
  it("does not reset weekly drawdown at an ordinary day boundary", async () => {
    const broker = start(); await realize(broker, -1000);
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    expect(broker.getState().accountState.dailyPnl).toBe(0);
    expect(broker.getState().accountState.weeklyDrawdown).toBeCloseTo(0.1);
  });
  it("rolls before applying a new-day close and includes only that day's realized leg", async () => {
    const broker = start("2026-11-06T23:59:59Z"); await broker.execute(plan, markedContext(10000));
    vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
    await broker.execute({ ...plan, action: "CLOSE", side: "SELL" }, markedContext(9800));
    expect(broker.getState().accountState.dailyPnl).toBe(-200);
    expect(broker.getState().accountState.dailyLossReferenceBalance).toBe(10000);
    expect(risk(broker).withinDailyLossLimit).toBe(false);
  });
  it("does not erase losses if the host clock moves backwards", async () => {
    const broker = start(); await realize(broker, -200);
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    expect(broker.getState().accountState.dailyPnl).toBe(-200);
    expect(risk(broker).withinDailyLossLimit).toBe(false);
  });
});
