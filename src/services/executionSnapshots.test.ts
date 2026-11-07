import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { config } from "../config.js";
import type { DecisionContext, ExecutionPlan, StrategySignal } from "../domain/types.js";
import type { PostgresStateStore } from "../infra/store/postgresStateStore.js";
import type { TelegramNotifier } from "../infra/notifier/telegramNotifier.js";
import { PaperBroker } from "./brokers.js";
import { ExecutionEngine } from "./executionEngine.js";
import { persistExecutionSnapshots } from "./executionSnapshots.js";
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

const plan: ExecutionPlan = {
  action: "LONG", side: "BUY", entryType: "MARKET", leverage: 2, quantity: 0.02,
  notionalUsd: 2000, entryPrice: 100000, stopLoss: 99000, tp2: 103000,
  confidence: 0.8, entryReason: "test", reasoningSummary: "test"
};
const signal = { bias: "LONG" } as StrategySignal;
function setup() {
  const runtime = new RuntimeState(10000);
  const broker = new PaperBroker(config);
  const execute = vi.spyOn(broker, "execute");
  const saveSnapshot = vi.fn().mockResolvedValue(undefined);
  const setJson = vi.fn().mockResolvedValue(undefined);
  const saveTrade = vi.fn().mockResolvedValue(undefined);
  const saveDecision = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const engine = new ExecutionEngine(config, runtime,
    { saveTrade, saveSnapshot, saveDecision } as unknown as PostgresStateStore,
    { notify } as unknown as TelegramNotifier, broker, { error: vi.fn(), info: vi.fn() } as unknown as Logger,
    undefined, result => persistExecutionSnapshots({ saveSnapshot }, { setJson }, result));
  return { runtime, broker, execute, saveSnapshot, setJson, saveTrade, notify, engine };
}
describe("execution state snapshots", () => {
  it("persists a paper entry before another market tick and a close exactly once", async () => {
    const f = setup();
    await f.engine.maybeExecute(context(), signal, { approved: true, reasons: [], normalizedSignal: signal, executionPlan: plan });
    const entry = f.broker.getState();
    expect(f.saveSnapshot.mock.calls).toEqual([["account", entry.accountState], ["position", entry.positionState]]);
    expect(f.setJson.mock.calls).toEqual([["latest:account", entry.accountState, 300], ["latest:position", entry.positionState, 300]]);
    f.saveSnapshot.mockClear(); f.setJson.mockClear();
    const close = await f.broker.execute({ ...plan, action: "CLOSE", side: "SELL" }, { ...context(), position_state: entry.positionState });
    await f.engine.handleExecutionResult(close);
    expect(f.saveSnapshot).toHaveBeenCalledTimes(2);
    expect(f.setJson).toHaveBeenCalledTimes(2);
    expect(f.setJson).toHaveBeenCalledWith("latest:position", expect.objectContaining({ side: "flat" }), 300);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  it("still persists the accepted state when the trade audit fails", async () => {
    const f = setup(); const error = new Error("audit unavailable"); f.saveTrade.mockRejectedValue(error);
    await expect(f.engine.maybeExecute(context(), signal, { approved: true, reasons: [], normalizedSignal: signal, executionPlan: plan })).rejects.toBe(error);
    expect(f.saveSnapshot).toHaveBeenCalledTimes(2); expect(f.setJson).toHaveBeenCalledTimes(2);
    expect(f.notify).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
  });
  it("attempts all state destinations and alerts without replay when one fails", async () => {
    const f = setup(); const error = new Error("snapshot unavailable"); f.saveSnapshot.mockRejectedValueOnce(error);
    await expect(f.engine.maybeExecute(context(), signal, { approved: true, reasons: [], normalizedSignal: signal, executionPlan: plan })).rejects.toBe(error);
    expect(f.saveSnapshot).toHaveBeenCalledTimes(2); expect(f.setJson).toHaveBeenCalledTimes(2);
    expect(f.saveTrade).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("snapshot persistence failed"));
  });
  it("keeps each simultaneous storage failure for callers", async () => {
    const a = new Error("postgres"); const b = new Error("redis");
    const saveSnapshot = vi.fn().mockRejectedValueOnce(a).mockResolvedValue(undefined);
    const setJson = vi.fn().mockRejectedValueOnce(b).mockResolvedValue(undefined);
    const error = await persistExecutionSnapshots({ saveSnapshot }, { setJson }, { accountState: context().account_state, positionState: context().position_state }).catch(e => e);
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toEqual([a, b]);
    expect(saveSnapshot).toHaveBeenCalledTimes(2); expect(setJson).toHaveBeenCalledTimes(2);
  });
});
