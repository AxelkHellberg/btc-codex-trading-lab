import { describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { DecisionContext, ExecutionAttemptRecord, ExecutionPlan, ExecutionResult } from "../domain/types.js";
import { createHttpServer } from "../http/server.js";
import { ExecutionEngine } from "./executionEngine.js";
import { RuntimeState } from "./runtimeState.js";

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

const plan: ExecutionPlan = {
  action: "LONG", side: "BUY", entryType: "MARKET", quantity: 0.01,
  leverage: 2, notionalUsd: 1000, entryPrice: 100000, confidence: 0.8,
  entryReason: "fixture", reasoningSummary: "fixture"
};
const setup = () => {
  const runtime = new RuntimeState(10000);
  const snapshots: { kind: string; payload: ExecutionAttemptRecord }[] = [];
  const store = { saveDecision: vi.fn().mockResolvedValue(undefined),
    saveTrade: vi.fn().mockResolvedValue(undefined),
    saveSnapshot: vi.fn(async (kind: string, payload: ExecutionAttemptRecord) => {
      snapshots.push({ kind, payload: { ...payload } });
    }) };
  const result: ExecutionResult = { accepted: false, broker: "stub", tradeId: "fixture", message: "not filled",
    accountState: runtime.getAccount(), positionState: runtime.getPosition() };
  const broker = { name: "stub", execute: vi.fn().mockResolvedValue(result) };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const notifier = { notify: vi.fn().mockResolvedValue(undefined) };
  const engine = new ExecutionEngine(config, runtime, store as never, notifier as never, broker, logger as never);
  const run = () => engine.maybeExecute(buildContext(), {
    bias: "LONG", confidence: 0.8, setup_type: "breakout", holding_horizon_minutes: 10,
    reasoning_summary: "fixture" }, { approved: true, executionPlan: plan, reasons: [], normalizedSignal: { bias: "LONG", confidence: 0.8, setup_type: "breakout", holding_horizon_minutes: 10, reasoning_summary: "fixture" } });
  return { runtime, store, snapshots, result, broker, logger, notifier, run, engine };
};

describe("durable broker execution attempts", () => {
  it("persists linked intent before invoking the broker", async () => {
    const s = setup();
    s.broker.execute.mockImplementation(async () => {
      expect(s.snapshots).toHaveLength(1);
      expect(s.snapshots[0]?.payload.status).toBe("started");
      return s.result;
    });
    await s.run();
    expect(s.snapshots.map((x) => x.payload.status)).toEqual(["started", "rejected"]);
    expect(s.snapshots[1]?.payload.decisionId).toBe(s.runtime.getRecentDecisions()[0]?.decisionId);
    expect(s.runtime.getRecentExecutionAttempts()).toHaveLength(1);
    expect(s.notifier.notify).not.toHaveBeenCalled();
  });

  it("records exceptions as unknown, preserves the error, and never repeats execution", async () => {
    const s = setup();
    const error = new Error("secret signed request body");
    s.broker.execute.mockRejectedValue(error);
    await expect(s.run()).rejects.toBe(error);
    expect(s.snapshots.map((x) => x.payload.status)).toEqual(["started", "unknown"]);
    expect(s.broker.execute).toHaveBeenCalledTimes(1);
    expect(s.runtime.getRecentDecisions()[0]?.approved).toBe(true);
    expect(s.runtime.getRecentExecutionAttempts()[0]).toMatchObject({ status: "unknown", phase: "broker.execute",
      broker: "stub", action: "LONG", quantity: 0.01 });
    expect(JSON.stringify([s.snapshots, s.notifier.notify.mock.calls, s.logger.error.mock.calls])).not.toContain("secret");
  });

  it("does not enter the broker when the intent cannot be persisted", async () => {
    const s = setup();
    s.store.saveSnapshot.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(s.run()).rejects.toThrow("database unavailable");
    expect(s.broker.execute).not.toHaveBeenCalled();
  });

  it("retains an unknown runtime outcome if its final audit write fails", async () => {
    const s = setup();
    const error = new Error("broker timeout");
    s.broker.execute.mockRejectedValue(error);
    s.store.saveSnapshot.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("database timeout"));
    s.notifier.notify.mockRejectedValueOnce(new Error("notification failed"));
    await expect(s.run()).rejects.toBe(error);
    expect(s.runtime.getRecentExecutionAttempts()[0]?.status).toBe("unknown");
    expect(s.broker.execute).toHaveBeenCalledTimes(1);
  });

  it("handles an accepted result even when final outcome persistence fails", async () => {
    const s = setup();
    s.broker.execute.mockResolvedValue({ ...s.result, accepted: true });
    s.store.saveSnapshot.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("database timeout"));
    await s.run();
    expect(s.runtime.getRecentExecutionAttempts()[0]?.status).toBe("accepted");
    expect(s.notifier.notify).toHaveBeenCalledTimes(1);
    expect(s.broker.execute).toHaveBeenCalledTimes(1);
  });

  it("does not relabel a known broker result when downstream handling fails", async () => {
    const s = setup();
    s.broker.execute.mockResolvedValue({ ...s.result, accepted: true });
    s.notifier.notify.mockRejectedValue(new Error("notification failed"));
    await expect(s.run()).rejects.toThrow("notification failed");
    expect(s.runtime.getRecentExecutionAttempts()[0]?.status).toBe("accepted");
  });

  it("leaves risk-rejected decisions without a broker attempt", async () => {
    const s = setup();
    await s.engine.maybeExecute(buildContext(), { bias: "FLAT", confidence: 0.5,
      setup_type: "continuation", holding_horizon_minutes: 10, reasoning_summary: "fixture" },
      { approved: false, reasons: ["risk limit"], normalizedSignal: { bias: "FLAT", confidence: 0.5, setup_type: "continuation", holding_horizon_minutes: 10, reasoning_summary: "fixture" } });
    expect(s.broker.execute).not.toHaveBeenCalled();
    expect(s.store.saveSnapshot).not.toHaveBeenCalled();
    expect(s.runtime.getRecentExecutionAttempts()).toEqual([]);
  });

  it("exposes unknown outcomes through HTTP status and the dashboard", async () => {
    const s = setup();
    s.broker.execute.mockRejectedValue(new Error("broker failed"));
    await expect(s.run()).rejects.toThrow("broker failed");
    const server = await createHttpServer(s.runtime, 33371);
    try {
      await server.start();
      const response = await fetch("http://127.0.0.1:33371/status");
      expect(response.ok).toBe(true);
      const body = await response.json();
      expect(body.recentExecutionAttempts[0].status).toBe("unknown");
      expect(body.recentExecutionAttempts[0].decisionId).toBe(body.recentDecisions[0].decisionId);
      const html = await fetch("http://127.0.0.1:33371/").then((res) => res.text());
      expect(html).toContain('id="executionAttempts"');
      expect(html).toContain('getElementById("executionAttempts").textContent');
    } finally { await server.stop(); }
  });
});
