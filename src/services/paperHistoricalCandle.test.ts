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

const start = Date.UTC(2020, 0, 1);
const setup = async (side: "long" | "short", fees = 0, slippage = 0) => {
  let now = start;
  const broker = new PaperBroker({ ...config, paperStartingBalance: 10_000, takerFeeBps: fees, slippageBps: slippage }, () => now);
  const plan: ExecutionPlan = {
    action: side === "long" ? "LONG" : "SHORT", side: side === "long" ? "BUY" : "SELL",
    entryType: "MARKET", quantity: 0.02, leverage: 2, entryPrice: 100_000, notionalUsd: 2_000,
    stopLoss: side === "long" ? 99_000 : 101_000,
    tp1: side === "long" ? 101_500 : 98_500, tp2: side === "long" ? 103_000 : 97_000,
    initialRiskPerUnit: 1_000, maxHoldUntil: start + 3_600_000,
    confidence: 0.8, entryReason: "fixture", reasoningSummary: "fixture"
  };
  await broker.execute(plan, context());
  now += 60_000;
  return { broker, plan, now };
};

describe("historical candle stop policy", () => {
  it.each(["long", "short"] as const)("does not lose a pre-existing %s stop when the close recovers", async (side) => {
    const { broker, now } = await setup(side);
    const candle = { openTime: start + 1, open: 100_000, high: side === "long" ? 100_500 : 101_500, low: side === "long" ? 98_500 : 99_500 };
    const result = await broker.onHistoricalCandle({ ...context().market_snapshot, timestamp: now }, candle);
    expect(result?.accepted).toBe(true);
    expect(result?.tradeRecord).toMatchObject({ status: "closed", exitReason: "stop_loss", closedAt: now, netPnl: -20 });
    expect(result?.positionState.side).toBe("flat");
    expect(broker.getState().accountState.walletBalance).toBe(9_980);
  });

  it.each(["long", "short"] as const)("fills a %s gap through the stop at the worse opening price", async (side) => {
    const { broker, now } = await setup(side);
    const candle = side === "long" ? { openTime: start + 1, open: 98_000, high: 100_500, low: 97_500 }
      : { openTime: start + 1, open: 102_000, high: 102_500, low: 99_500 };
    const result = await broker.onHistoricalCandle({ ...context().market_snapshot, timestamp: now }, candle);
    expect(result?.tradeRecord?.netPnl).toBe(-40);
    expect(result?.positionState.markPrice).toBe(candle.open);
    expect(broker.getState().accountState.walletBalance).toBe(9_960);
  });

  it.each(["long", "short"] as const)("resolves ambiguous %s bars against the position before any target fill", async (side) => {
    const { broker, now } = await setup(side);
    const result = await broker.onHistoricalCandle({ ...context().market_snapshot, timestamp: now }, { openTime: start + 1, open: 100_000, high: 104_000, low: 96_000 });
    expect(result?.tradeRecord).toMatchObject({ status: "closed", exitReason: "stop_loss", remainingQuantity: 0, netPnl: -20 });
    expect(broker.getState().accountState.walletBalance).toBe(9_980);
  });

  it("keeps a no-crossing bar open and marks it at the close", async () => {
    const { broker, now } = await setup("long");
    const result = await broker.onHistoricalCandle({ ...context().market_snapshot, markPrice: 100_100, timestamp: now }, { openTime: start + 1, open: 100_000, high: 100_500, low: 99_500 });
    expect(result).toBeNull();
    expect(broker.getState().positionState).toMatchObject({ side: "long", quantity: 0.02, markPrice: 100_100 });
    expect(broker.getState().accountState.equity).toBe(10_002);
  });

  it("does not apply a bar's earlier extremes to an entry made at its close", async () => {
    const broker = new PaperBroker({ ...config, slippageBps: 0, takerFeeBps: 0 }, () => start + 60_000);
    const snapshot = { ...context().market_snapshot, timestamp: start + 60_000 };
    expect(await broker.onHistoricalCandle(snapshot, { openTime: start + 1, open: 100_000, high: 104_000, low: 96_000 })).toBeNull();
    const { plan } = await setup("long");
    await broker.execute(plan, context());
    expect(await broker.onHistoricalCandle(snapshot, { openTime: start + 1, open: 100_000, high: 104_000, low: 96_000 })).toBeNull();
    expect(broker.getState().positionState.side).toBe("long");
  });

  it("keeps real-time ticks close-only without reading contextual intraday extremes", async () => {
    const { broker } = await setup("long");
    expect(await broker.onMarketSnapshot({ ...context().market_snapshot, intradayLow: 98_000 })).toBeNull();
    expect(broker.getState().positionState.side).toBe("long");
  });

  it("charges existing paper slippage and fees on a historical stop fill", async () => {
    const { broker, now } = await setup("long", 10, 10);
    const result = await broker.onHistoricalCandle({ ...context().market_snapshot, timestamp: now }, { openTime: start + 1, open: 100_000, high: 100_500, low: 98_500 });
    const entry = 100_000 * 1.001;
    const exit = 99_000 * 0.999;
    const net = (exit - entry) * 0.02 - (entry + exit) * 0.02 * 0.001;
    expect(result?.tradeRecord?.netPnl).toBeCloseTo(net);
    expect(broker.getState().accountState.walletBalance).toBeCloseTo(10_000 + net);
  });

  it.each([
    { openTime: start + 1, open: NaN, high: 100_500, low: 98_500 },
    { openTime: start + 1, open: 100_000, high: 99_000, low: 98_500 },
    { openTime: start + 120_000, open: 100_000, high: 100_500, low: 98_500 }
  ])("rejects invalid historical samples before mutating paper state", async (bar) => {
    const { broker, now } = await setup("long");
    const before = broker.getState();
    await expect(broker.onHistoricalCandle({ ...context().market_snapshot, timestamp: now }, bar)).rejects.toThrow("Invalid historical candle");
    expect(broker.getState()).toEqual(before);
  });
});
