import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { DecisionContext, ExecutionPlan, StrategySignal } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { PaperBroker, LiveBroker } from "./brokers.js";
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

const signal: StrategySignal = { bias: "LONG", confidence: 0.62, setup_type: "breakout", invalidation_price: 99_000, holding_horizon_minutes: 90, reasoning_summary: "Offline regression" };
const localConfig = { ...config, slippageBps: 0, takerFeeBps: 4, paperStartingBalance: 10_000 };
const plan = () => new StrategyPlanner(localConfig).plan(buildContext(), signal).plan!;
const nonfinite = [NaN, Infinity, -Infinity];

describe("finite entry execution invariant", () => {
  it.each(nonfinite)("rejects nonfinite equity %s before planning", value => {
    const context = buildContext();
    context.account_state.equity = value;
    const planning = new StrategyPlanner(localConfig).plan(context, signal);
    expect(planning.plan).toBeUndefined();
    expect(planning.reasons.join(" ")).toMatch(/equity/);
  });

  it.each(["stepSize", "tickSize", "minQty"] as const)("rejects invalid supplied %s before planning", field => {
    for (const value of [...nonfinite, 0, -1]) {
      const context = buildContext();
      context.market_snapshot.filters![field] = value;
      const planning = new StrategyPlanner(localConfig).plan(context, signal);
      expect(planning.plan).toBeUndefined();
      expect(planning.reasons.join(" ")).toContain(field);
    }
  });

  it.each(["quantity", "entryPrice", "notionalUsd", "stopLoss", "tp1", "tp2", "initialRiskPerUnit", "leverage", "trailingOffset", "maxHoldUntil"] as const)("rejects nonfinite plan %s at risk and both brokers", async field => {
    for (const value of nonfinite) {
      const context = buildContext();
      const invalid: ExecutionPlan = { ...plan(), [field]: value };
      const evaluation = new RiskEngine(localConfig).evaluate(context, { normalizedSignal: signal, plan: invalid, reasons: [] });
      expect(evaluation.approved).toBe(false);
      expect(evaluation.reasons.join(" ")).toContain(field);
      const paper = new PaperBroker(localConfig);
      const before = paper.getState();
      const result = await paper.execute(invalid, context);
      expect(result.accepted).toBe(false);
      expect(paper.getState()).toEqual(before);
      const client = { changeLeverage: vi.fn(), createOrder: vi.fn(), getBalanceState: vi.fn(), getPositionState: vi.fn() };
      const live = new LiveBroker(localConfig, client as unknown as BinanceFuturesClient, { warn: vi.fn() } as unknown as Logger);
      expect((await live.execute(invalid, context)).accepted).toBe(false);
      for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled();
    }
  });

  it.each([0, -1])("rejects nonpositive quantity %s without mutating the broker", async quantity => {
    const context = buildContext();
    const invalid = { ...plan(), quantity };
    expect(new RiskEngine(localConfig).evaluate(context, { normalizedSignal: signal, plan: invalid, reasons: [] }).approved).toBe(false);
    const broker = new PaperBroker(localConfig);
    const before = broker.getState();
    expect((await broker.execute(invalid, context)).accepted).toBe(false);
    expect(broker.getState()).toEqual(before);
  });

  it("keeps a healthy planner-risk-paper path finite", async () => {
    const context = buildContext();
    const planning = new StrategyPlanner(localConfig).plan(context, signal);
    const risk = new RiskEngine(localConfig).evaluate(context, planning);
    expect(risk.approved).toBe(true);
    const result = await new PaperBroker(localConfig).execute(risk.executionPlan!, context);
    expect(result.accepted).toBe(true);
    expect(Number.isFinite(result.accountState.walletBalance)).toBe(true);
    expect(result.positionState.quantity).toBeGreaterThan(0);
  });

  it("rejects invalid marks and overflowing entry arithmetic at every boundary", async () => {
    for (const markPrice of [...nonfinite, 0, -1]) {
      const context = buildContext();
      context.market_snapshot.markPrice = markPrice;
      expect(new StrategyPlanner(localConfig).plan(context, signal).plan).toBeUndefined();
      const broker = new PaperBroker(localConfig);
      const before = broker.getState();
      expect((await broker.execute(plan(), context)).accepted).toBe(false);
      expect(broker.getState()).toEqual(before);
    }
    const context = buildContext();
    const invalid = { ...plan(), quantity: Number.MAX_VALUE, entryPrice: Number.MAX_VALUE };
    expect(new RiskEngine(localConfig).evaluate(context, { normalizedSignal: signal, plan: invalid, reasons: [] }).approved).toBe(false);
    expect((await new PaperBroker(localConfig).execute(invalid, context)).accepted).toBe(false);
  });

  it("leaves REDUCE eligible when entry-only equity is invalid", async () => {
    const context = buildContext();
    const paper = new PaperBroker(localConfig);
    const opened = await paper.execute(plan(), context);
    context.position_state = opened.positionState;
    context.account_state = { ...opened.accountState, equity: NaN };
    const reduce = { ...plan(), action: "REDUCE" as const, side: "SELL" as const, quantity: opened.positionState.quantity / 2 };
    const result = new RiskEngine(localConfig).evaluate(context, { normalizedSignal: { ...signal, bias: "REDUCE" }, plan: reduce, reasons: [] });
    expect(result.approved).toBe(true);
    expect((await paper.execute(result.executionPlan!, context)).accepted).toBe(true);
    expect(paper.getState().positionState.quantity).toBeCloseTo(opened.positionState.quantity / 2);
  });

  it("preserves the SHORT and mocked live healthy entry paths", async () => {
    const context = buildContext();
    context.context_summary.regime = "trend_down";
    context.context_summary.trend_bias = "bearish";
    const short = { ...signal, bias: "SHORT" as const, invalidation_price: 101_000 };
    const planning = new StrategyPlanner(localConfig).plan(context, short);
    const risk = new RiskEngine(localConfig).evaluate(context, planning);
    expect(risk.approved).toBe(true);
    const client = {
      changeLeverage: vi.fn().mockResolvedValue(undefined), createOrder: vi.fn().mockResolvedValue({}),
      getBalanceState: vi.fn().mockResolvedValue(context.account_state), getPositionState: vi.fn().mockResolvedValue({ ...context.position_state, side: "short", quantity: planning.plan!.quantity })
    };
    const live = new LiveBroker(localConfig, client as unknown as BinanceFuturesClient, { warn: vi.fn() } as unknown as Logger);
    expect((await live.execute(risk.executionPlan!, context)).accepted).toBe(true);
    expect(client.createOrder).toHaveBeenCalledTimes(3);
  });

  it("does not apply entry-only field requirements to CLOSE", async () => {
    const context = buildContext();
    const paper = new PaperBroker(localConfig);
    const opened = await paper.execute(plan(), context);
    context.position_state = opened.positionState;
    context.account_state = opened.accountState;
    context.account_state.equity = NaN;
    context.market_snapshot.filters!.stepSize = NaN;
    const close: ExecutionPlan = { ...plan(), action: "CLOSE", side: "SELL", quantity: opened.positionState.quantity, stopLoss: undefined, tp2: undefined, initialRiskPerUnit: undefined };
    const result = new RiskEngine(localConfig).evaluate(context, { normalizedSignal: { ...signal, bias: "CLOSE" }, plan: close, reasons: [] });
    expect(result.approved).toBe(true);
    expect((await paper.execute(result.executionPlan!, context)).accepted).toBe(true);
    expect(paper.getState().positionState.side).toBe("flat");
  });
});
