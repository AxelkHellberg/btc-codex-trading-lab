import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { config } from "../config.js";
import type { DecisionContext, ExecutionPlan, PositionState, RiskEvaluation, StrategySignal } from "../domain/types.js";
import { PaperBroker } from "./brokers.js";
import { RuntimeState } from "./runtimeState.js";
import { ExecutionEngine } from "./executionEngine.js";
import type { PostgresStateStore } from "../infra/store/postgresStateStore.js";
import type { TelegramNotifier } from "../infra/notifier/telegramNotifier.js";

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

const signal: StrategySignal = {
  bias: "REDUCE", confidence: 0.9, setup_type: "breakout",
  holding_horizon_minutes: 60, reasoning_summary: "reduce exposure"
};
const openPlan = (side: "long" | "short"): ExecutionPlan => ({
  action: side === "long" ? "LONG" : "SHORT", side: side === "long" ? "BUY" : "SELL",
  entryType: "MARKET", leverage: 2, quantity: 0.02, notionalUsd: 2_000, entryPrice: 100_000,
  stopLoss: side === "long" ? 99_000 : 101_000, tp1: side === "long" ? 101_500 : 98_500,
  tp2: side === "long" ? 103_000 : 97_000, initialRiskPerUnit: 1_000,
  maxHoldUntil: Date.now() + 3_600_000, confidence: 0.8,
  entryReason: "fixture", reasoningSummary: "fixture"
});
const exitPlan = (state: PositionState, action: "REDUCE" | "CLOSE" = "REDUCE"): ExecutionPlan => ({
  ...openPlan(state.side as "long" | "short"), action,
  side: state.side === "long" ? "SELL" : "BUY",
  quantity: action === "REDUCE" ? state.quantity / 2 : state.quantity
});
const setup = async (side: "long" | "short") => {
  const broker = new PaperBroker({ ...config, paperStartingBalance: 10_000, takerFeeBps: 0, slippageBps: 0 });
  await broker.execute(openPlan(side), context());
  const captured = { ...context(), position_state: broker.getState().positionState };
  return { broker, captured };
};
const tp1 = async (broker: PaperBroker, side: "long" | "short") => {
  const result = await broker.onMarketSnapshot({ ...context().market_snapshot, markPrice: side === "long" ? 101_600 : 98_400 });
  expect(result?.positionState.quantity).toBeCloseTo(0.01);
};

describe("paper exit position freshness", () => {
  it.each(["long", "short"] as const)("rejects a delayed %s reduction after TP1 while the model is pending", async (side) => {
    const { broker, captured } = await setup(side);
    let finish!: (value: StrategySignal) => void;
    const pendingModel = new Promise<StrategySignal>((resolve) => { finish = resolve; });
    const work = (async () => { await pendingModel; return broker.execute(exitPlan(captured.position_state), captured); })();
    await tp1(broker, side);
    const before = broker.getState();
    finish(signal);
    const result = await work;
    expect(result.accepted).toBe(false);
    expect(result.message).toContain("position changed");
    expect(result.tradeRecord).toBeUndefined();
    expect(broker.getState()).toEqual(before);
  });

  it.each(["long", "short"] as const)("rejects a stale %s exit after decision persistence latency", async (side) => {
    const { broker, captured } = await setup(side);
    const runtime = new RuntimeState(10_000);
    runtime.setPosition(captured.position_state);
    let finish!: () => void;
    const saved = new Promise<void>((resolve) => { finish = resolve; });
    const store = { saveDecision: vi.fn(() => saved), saveTrade: vi.fn() };
    const notifier = { notify: vi.fn() };
    const engine = new ExecutionEngine(config, runtime, store as unknown as PostgresStateStore,
      notifier as unknown as TelegramNotifier, broker, pino({ level: "silent" }));
    const execute = vi.spyOn(broker, "execute");
    const evaluation: RiskEvaluation = { approved: true, reasons: [], normalizedSignal: signal, executionPlan: exitPlan(captured.position_state) };
    const work = engine.maybeExecute(captured, signal, evaluation);
    expect(store.saveDecision).toHaveBeenCalledTimes(1);
    await tp1(broker, side);
    const before = broker.getState();
    finish();
    await work;
    expect((await execute.mock.results[0]!.value).accepted).toBe(false);
    expect(runtime.getPosition()).toEqual(before.positionState);
    expect(broker.getState()).toEqual(before);
    expect(store.saveTrade).not.toHaveBeenCalled();
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it.each(["REDUCE", "CLOSE"] as const)("preserves explicit %s against the unchanged position", async (action) => {
    const { broker, captured } = await setup("long");
    const result = await broker.execute(exitPlan(captured.position_state, action), captured);
    expect(result.accepted).toBe(true);
    expect(result.positionState.quantity).toBe(action === "REDUCE" ? 0.01 : 0);
  });

  it("permits a newly evaluated reduction after TP1", async () => {
    const { broker, captured } = await setup("long");
    await tp1(broker, "long");
    captured.position_state = broker.getState().positionState;
    const result = await broker.execute(exitPlan(captured.position_state), captured);
    expect(result.accepted).toBe(true);
    expect(result.positionState.quantity).toBeCloseTo(0.005);
  });

  it("rejects the old decision after the position closed", async () => {
    const { broker, captured } = await setup("long");
    await broker.onMarketSnapshot({ ...context().market_snapshot, markPrice: 98_000 });
    const before = broker.getState();
    const result = await broker.execute(exitPlan(captured.position_state), captured);
    expect(result.accepted).toBe(false);
    expect(result.message).toContain("position changed");
    expect(broker.getState()).toEqual(before);
  });

  it("rejects a replacement position even at the same side, quantity and entry price", async () => {
    const { broker, captured } = await setup("long");
    await broker.execute(exitPlan(captured.position_state, "CLOSE"), captured);
    await broker.execute(openPlan("long"), context());
    const before = broker.getState();
    expect(before.positionState.sourceTradeId).not.toBe(captured.position_state.sourceTradeId);
    const result = await broker.execute(exitPlan(captured.position_state), captured);
    expect(result.accepted).toBe(false);
    expect(broker.getState()).toEqual(before);
  });

  it("does not reject an unchanged position merely because its mark moved", async () => {
    const { broker, captured } = await setup("long");
    await broker.onMarketSnapshot({ ...context().market_snapshot, markPrice: 100_100 });
    expect((await broker.execute(exitPlan(captured.position_state), captured)).accepted).toBe(true);
  });
});
