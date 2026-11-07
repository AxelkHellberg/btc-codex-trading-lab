import { describe, expect, it } from "vitest";
import type { DecisionContext } from "../domain/types.js";
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

describe("RuntimeState mark-to-market account consistency", () => {
  const setup = (side: "long" | "short" = "long") => {
    const runtime = new RuntimeState(10_000);
    runtime.setAccount({ ...context().account_state, equity: 10_030, availableBalance: 8_000, dailyPnl: -50 });
    runtime.setPosition({ ...context().position_state, side, quantity: 2, entryPrice: 100, markPrice: 110, unrealizedPnl: side === "long" ? 20 : -20 });
    return runtime;
  };
  it.each(["long", "short"] as const)("applies only the %s position delta to account equity", (side) => {
    const runtime = setup(side);
    runtime.setMarket({ ...context().market_snapshot, markPrice: 115, timestamp: 12345 });
    expect(runtime.getPosition().unrealizedPnl).toBe(side === "long" ? 30 : -30);
    expect(runtime.getAccount()).toMatchObject({ equity: side === "long" ? 10040 : 10020, walletBalance: 10000, availableBalance: 8000, dailyPnl: -50, updatedAt: 12345 });
    runtime.setMarket({ ...context().market_snapshot, markPrice: 115, timestamp: 12346 });
    expect(runtime.getAccount().equity).toBe(side === "long" ? 10040 : 10020);
    runtime.setMarket({ ...context().market_snapshot, markPrice: 90 });
    expect(runtime.getAccount().equity).toBe(side === "long" ? 9990 : 10070);
  });
  it("uses a refreshed account and position as the new delta baseline", () => {
    const runtime = setup();
    runtime.setMarket({ ...context().market_snapshot, markPrice: 115 });
    runtime.setAccount({ ...context().account_state, equity: 20_050 });
    runtime.setPosition({ ...runtime.getPosition(), quantity: 1, markPrice: 120, unrealizedPnl: 20 });
    runtime.setMarket({ ...context().market_snapshot, markPrice: 125 });
    expect(runtime.getAccount().equity).toBe(20055);
  });
  it("does not change a flat account on market ticks", () => {
    const runtime = new RuntimeState(10000);
    const account = runtime.getAccount();
    runtime.setMarket({ ...context().market_snapshot, markPrice: 115 });
    expect(runtime.getAccount()).toEqual(account);
  });
});
