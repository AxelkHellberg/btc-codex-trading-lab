import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { DecisionContext, StrategySignal } from "../domain/types.js";
import { RuntimeState } from "./runtimeState.js";
import { StrategyPlanner } from "./strategyPlanner.js";
import { RiskEngine } from "./riskEngine.js";
import { ExecutionEngine } from "./executionEngine.js";
import { LiveBroker } from "./brokers.js";
import { MarketIngestor } from "./marketIngestor.js";

const now = 1_800_000_000_000;
const context = (): DecisionContext => ({
  market_snapshot: {
    symbol: "BTCUSDT", markPrice: 100_000, indexPrice: 100_000, lastPrice: 100_000,
    bestBid: 99_999, bestAsk: 100_001, spreadBps: 0.2, fundingRate: 0.0001,
    nextFundingTime: now + 60_000, openInterest: 500_000, openInterestChangePct1m: 0.2,
    topTraderLongShortRatio: 1.1, volume1m: 120, priceChangePct1m: 0.4, priceChangePct5m: 0.8,
    priceChangePct15m: 1.2, priceChangePct1h: 2.4, intradayHigh: 101000, intradayLow: 98000,
    distanceFromIntradayHighPct: 0.99, distanceFromIntradayLowPct: 2.04, emaFast: 100300,
    emaMedium: 99900, trendStrengthPct: 0.4, volumeAcceleration: 1.4, timestamp: now,
    inputTimestamps: { mark: now, quote: now, candle: now },
    filters: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 }
  },
  derivatives_snapshot: { funding_rate: 0.0001, next_funding_time: now + 60_000,
    open_interest: 500_000, open_interest_change_pct_1m: 0.2, top_trader_long_short_ratio: 1.1 },
  news_events: [], onchain_snapshot: null,
  position_state: { side: "flat", quantity: 0, entryPrice: 0, markPrice: 0, leverage: 1, unrealizedPnl: 0, realizedPnl: 0 },
  account_state: { equity: 10_000, walletBalance: 10_000, availableBalance: 10_000,
    dailyPnl: 0, weeklyDrawdown: 0, consecutiveLosses: 0, openOrders: 0, updatedAt: now },
  risk_state: { withinDailyLossLimit: true, withinWeeklyDrawdown: true, cooldownActive: false, reasons: [] },
  context_summary: { regime: "trend_up", trend_bias: "bullish", catalyst_bias: "neutral", momentum_score: 0.64,
    key_levels: { intraday_high: 101000, intraday_low: 98000 }, notes: [] },
  trigger: { reason: "minute_recheck", priority: 1, details: "test", triggeredAt: now }
});
const signal: StrategySignal = { bias: "LONG", confidence: 0.8, setup_type: "breakout",
  invalidation_price: 99_000, holding_horizon_minutes: 90, reasoning_summary: "test" };
const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const planning = (ctx: DecisionContext, value = signal) => new StrategyPlanner(config).plan(ctx, value);
const rig = () => {
  const runtime = new RuntimeState(10_000);
  const store = { saveDecision: vi.fn().mockResolvedValue(undefined) };
  const broker = { execute: vi.fn() };
  const logger = log();
  const engine = new ExecutionEngine(config, runtime, store as any, {} as any, broker as any, logger as any);
  return { engine, store, broker, logger };
};
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("entry input freshness", () => {
  it.each(["mark", "quote", "candle"] as const)("rejects an expired %s even when the aggregate snapshot is current", key => {
    const ctx = context(); ctx.market_snapshot.inputTimestamps![key] = now - 90_001;
    const result = new RiskEngine(config).evaluate(ctx, planning(ctx));
    expect(result.approved).toBe(false);
    expect(result.reasons).toContain(`market ${key} input is stale or invalid`);
  });
  it.each([NaN, Infinity, now + 1, 0])("rejects invalid or future input time %s", timestamp => {
    const ctx = context(); ctx.market_snapshot.inputTimestamps!.quote = timestamp;
    expect(new RiskEngine(config).evaluate(ctx, planning(ctx)).approved).toBe(false);
  });
  it("fails closed for snapshots without source timestamps", () => {
    const ctx = context(); delete ctx.market_snapshot.inputTimestamps;
    expect(new RiskEngine(config).evaluate(ctx, planning(ctx)).approved).toBe(false);
  });
  it("accepts the exact age limit and restores eligibility on a new snapshot", () => {
    const ctx = context(); vi.setSystemTime(now + 90_000);
    expect(new RiskEngine(config).evaluate(ctx, planning(ctx)).approved).toBe(true);
    vi.setSystemTime(now + 90_001);
    expect(new RiskEngine(config).evaluate(ctx, planning(ctx)).approved).toBe(false);
    vi.setSystemTime(now);
    expect(new RiskEngine(config).evaluate(context(), planning(context())).approved).toBe(true);
  });
  it("uses replay time explicitly instead of expiring historical candles against wall time", () => {
    const ctx = context(); vi.setSystemTime(now + 1_000_000);
    expect(new RiskEngine(config).evaluate(ctx, planning(ctx), now).approved).toBe(true);
  });
  it.each(["CLOSE", "REDUCE"] as const)("does not impose entry freshness on %s", bias => {
    const ctx = context(); delete ctx.market_snapshot.inputTimestamps;
    ctx.position_state = { ...ctx.position_state, side: "long", quantity: 0.02, entryPrice: 100_000 };
    const exit = { ...signal, bias };
    expect(new RiskEngine(config).evaluate(ctx, planning(ctx, exit)).approved).toBe(true);
  });
  it("rejects an approval that aged while the model was running and records the reason", async () => {
    const ctx = context(); const evaluated = new RiskEngine(config).evaluate(ctx, planning(ctx));
    vi.setSystemTime(now + 90_001);
    const r = rig(); await r.engine.maybeExecute(ctx, signal, evaluated);
    expect(r.broker.execute).not.toHaveBeenCalled();
    expect(r.store.saveDecision).toHaveBeenCalledWith(expect.objectContaining({ approved: false,
      reasons: expect.arrayContaining(["market quote input is stale or invalid"]) }));
  });
  it("rechecks immediately after a stalled audit write before submitting an entry", async () => {
    const ctx = context(); const r = rig(); let release!: () => void;
    r.store.saveDecision.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const pending = r.engine.maybeExecute(ctx, signal, new RiskEngine(config).evaluate(ctx, planning(ctx)));
    await Promise.resolve(); vi.setSystemTime(now + 90_001); release(); await pending;
    expect(r.broker.execute).not.toHaveBeenCalled();
    expect(r.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ reasons: expect.any(Array) }),
      "Entry expired before broker submission");
  });
  it("keeps supplemental refreshes from refreshing unchanged quote and candle timestamps", async () => {
    const client = { getMarkPrice: vi.fn().mockResolvedValue({ markPrice: 100_001, indexPrice: 100_001, fundingRate: 0, nextFundingTime: now }),
      getOpenInterest: vi.fn().mockResolvedValue(500_000), getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1) };
    const onMarket = vi.fn();
    const ingestor = new MarketIngestor({ ...config, tradingMode: "paper" }, client as any, log() as any,
      { onMarket, onAccount: vi.fn(), onPosition: vi.fn() });
    (ingestor as any).snapshot = context().market_snapshot;
    vi.setSystemTime(now + 100_000); await (ingestor as any).refreshSupplemental();
    const snapshot = onMarket.mock.calls[0]![0];
    expect(snapshot.inputTimestamps).toEqual({ mark: now + 100_000, quote: now, candle: now });
    const ctx = { ...context(), market_snapshot: snapshot };
    expect(new RiskEngine(config).evaluate(ctx, planning(ctx)).approved).toBe(false);
  });
  it("submits a fresh approved entry and allows a fresh reevaluation after rejection", async () => {
    const ctx = context(); const r = rig();
    r.broker.execute.mockResolvedValue({ accepted: false, message: "test rejection", accountState: ctx.account_state,
      positionState: ctx.position_state });
    vi.setSystemTime(now + 90_001);
    await r.engine.maybeExecute(ctx, signal, new RiskEngine(config).evaluate(ctx, planning(ctx)));
    expect(r.broker.execute).not.toHaveBeenCalled();
    ctx.market_snapshot.inputTimestamps = { mark: Date.now(), quote: Date.now(), candle: Date.now() };
    await r.engine.maybeExecute(ctx, signal, new RiskEngine(config).evaluate(ctx, planning(ctx)));
    expect(r.broker.execute).toHaveBeenCalledOnce();
  });
  it.each([
    [{ p: "100001", i: "100001", r: "0", T: now, E: now + 1000 }, "mark"],
    [{ b: "100000", a: "100002", E: now + 1000 }, "quote"],
    [{ k: { c: "100001", h: "100002", l: "100000", v: "3", x: false }, E: now + 1000 }, "candle"]
  ] as const)("updates only the observed websocket component %#", async (data, component) => {
    const onMarket = vi.fn(); const ingestor = new MarketIngestor(config, {} as any, log() as any,
      { onMarket, onAccount: vi.fn(), onPosition: vi.fn() });
    (ingestor as any).snapshot = context().market_snapshot;
    await (ingestor as any).handleMarketMessage(JSON.stringify({ data }));
    expect(onMarket.mock.calls[0]![0].inputTimestamps).toEqual({ mark: now, quote: now, candle: now, [component]: now + 1000 });
  });

  it("does not mutate leverage for stale inputs even when the live broker is called directly", async () => {
    const ctx = context(); const client = { changeLeverage: vi.fn(), createOrder: vi.fn() };
    const broker = new LiveBroker(config, client as any, log() as any);
    const plan = planning(ctx).plan!; vi.setSystemTime(now + 90_001);
    await expect(broker.execute(plan, ctx)).rejects.toThrow("Live entry refused");
    expect(client.changeLeverage).not.toHaveBeenCalled(); expect(client.createOrder).not.toHaveBeenCalled();
  });
  it("rechecks after a delayed leverage response and sends no expired entry order", async () => {
    const ctx = context(); let release!: () => void;
    const client = { changeLeverage: vi.fn(() => new Promise<void>(resolve => { release = resolve; })), createOrder: vi.fn() };
    const broker = new LiveBroker(config, client as any, log() as any);
    const pending = broker.execute(planning(ctx).plan!, ctx);
    vi.setSystemTime(now + 90_001); release();
    await expect(pending).rejects.toThrow("Live entry refused"); expect(client.createOrder).not.toHaveBeenCalled();
  });

});
