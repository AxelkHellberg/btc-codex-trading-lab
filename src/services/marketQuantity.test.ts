import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import type { DecisionContext, StrategySignal, SymbolFilters } from "../domain/types.js";
import { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { RiskEngine } from "./riskEngine.js";
import { StrategyPlanner } from "./strategyPlanner.js";

const config = { riskPolicy: { maxLeverage: 3, riskPerTrade: 0.01, maxOpenPositions: 1, minRiskReward: 2 } } as AppConfig;
const filters = (market = { minQty: 0.001, maxQty: 0.01, stepSize: 0.001 }): SymbolFilters => ({
  tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 100, minNotional: 5, marketLotSize: market
} as SymbolFilters);
const context = (value: SymbolFilters): DecisionContext => ({
  market_snapshot: { symbol: "BTCUSDT", markPrice: 100_000, volumeAcceleration: 1.4, filters: value },
  account_state: { equity: 10_000, walletBalance: 10_000, availableBalance: 10_000, openOrders: 0 },
  position_state: { side: "flat", quantity: 0 },
  risk_state: { withinDailyLossLimit: true, withinWeeklyDrawdown: true, cooldownActive: false },
  context_summary: { regime: "trend_up", trend_bias: "bullish" }
} as DecisionContext);
const signal = (bias: "LONG" | "SHORT"): StrategySignal => ({
  bias, confidence: 0.66, setup_type: "breakout", invalidation_price: bias === "LONG" ? 99_000 : 101_000,
  holding_horizon_minutes: 90, reasoning_summary: "synthetic fixture"
});
const planning = (c: DecisionContext, bias: "LONG" | "SHORT") => new StrategyPlanner(config).plan(c, signal(bias));

describe("market entry quantity filters", () => {
  it("retains separate LOT_SIZE and MARKET_LOT_SIZE values from exchange info", async () => {
    const client = new BinanceFuturesClient("https://unused.invalid", "", "", "", {} as Logger);
    vi.spyOn(client as unknown as { publicGet(): Promise<unknown> }, "publicGet").mockResolvedValue({ symbols: [{ symbol: "BTCUSDT", filters: [
      { filterType: "PRICE_FILTER", tickSize: "0.1" },
      { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
      { filterType: "MARKET_LOT_SIZE", minQty: "0.002", maxQty: "0.010", stepSize: "0.002" }
    ] }] });
    expect(await client.getSymbolFilters("BTCUSDT")).toMatchObject({
      minQty: 0.001, maxQty: 100, stepSize: 0.001,
      marketLotSize: { minQty: 0.002, maxQty: 0.01, stepSize: 0.002 }
    });
  });

  it.each(["LONG", "SHORT"] as const)("rejects an oversized %s plan without increasing or silently capping its size", (bias) => {
    const c = context(filters());
    if (bias === "SHORT") c.context_summary = { ...c.context_summary, regime: "trend_down", trend_bias: "bearish" };
    const result = planning(c, bias);
    expect(result.plan!.quantity).toBeGreaterThan(0.01);
    expect(result.reasons).toContain("MARKET_LOT_SIZE quantity exceeds maximum");
    expect(new RiskEngine(config).evaluate(c, result).approved).toBe(false);
  });

  it.each([
    [0.001, false], [0.002, true], [0.003, false], [0.01, true], [0.010001, false], [0.012, false]
  ])("independently evaluates direct quantity %s (approved=%s)", (quantity, approved) => {
    const c = context(filters({ minQty: 0.002, maxQty: 0.01, stepSize: 0.002 }));
    const result = planning(c, "LONG");
    result.reasons = [];
    result.plan = { ...result.plan!, quantity: Number(quantity), notionalUsd: Number(quantity) * 100_000 };
    expect(new RiskEngine(config).evaluate(c, result).approved).toBe(approved);
  });

  it("checks the LOT_SIZE maximum even if the market maximum is larger", () => {
    const c = context({ ...filters({ minQty: 0.001, maxQty: 1, stepSize: 0.001 }), maxQty: 0.01 } as SymbolFilters);
    const result = planning(c, "LONG");
    result.reasons = [];
    expect(new RiskEngine(config).evaluate(c, result).reasons).toContain("LOT_SIZE quantity exceeds maximum");
  });

  it("uses the minQty offset when checking the market quantity grid", () => {
    const c = context(filters({ minQty: 0.001, maxQty: 0.1, stepSize: 0.002 }));
    const result = planning(c, "LONG");
    result.reasons = [];
    result.plan = { ...result.plan!, quantity: 0.003 };
    expect(new RiskEngine(config).evaluate(c, result).approved).toBe(true);
    result.plan.quantity = 0.004;
    expect(new RiskEngine(config).evaluate(c, result).approved).toBe(false);
  });

  it.each([NaN, Infinity, -1, 0])("rejects a malformed market step %s", (stepSize) => {
    const c = context(filters({ minQty: 0.001, maxQty: 0.1, stepSize }));
    const result = planning(c, "LONG");
    result.reasons = [];
    expect(new RiskEngine(config).evaluate(c, result).approved).toBe(false);
  });

  it.each([NaN, Infinity, -1, 0, 0.0001])("rejects a malformed market maximum %s", (maxQty) => {
    const c = context(filters({ minQty: 0.001, maxQty, stepSize: 0.001 }));
    const result = planning(c, "LONG");
    result.reasons = [];
    expect(new RiskEngine(config).evaluate(c, result).approved).toBe(false);
  });

  it("enforces a stricter LOT_SIZE minimum and grid independently of market rules", () => {
    const c = context({ ...filters({ minQty: 0.001, maxQty: 0.1, stepSize: 0.001 }), minQty: 0.002, stepSize: 0.002 });
    const result = planning(c, "LONG");
    result.reasons = [];
    result.plan = { ...result.plan!, quantity: 0.001 };
    expect(new RiskEngine(config).evaluate(c, result).approved).toBe(false);
    result.plan.quantity = 0.003;
    expect(new RiskEngine(config).evaluate(c, result).reasons).toContain("LOT_SIZE quantity is off step");
  });

  it("accepts an exact decimal grid despite binary arithmetic noise", () => {
    const c = context({ ...filters({ minQty: 0.1, maxQty: 1, stepSize: 0.1 }), minQty: 0.1, stepSize: 0.1 });
    const result = planning(c, "LONG");
    result.reasons = [];
    result.plan = { ...result.plan!, quantity: 0.3 };
    expect(new RiskEngine(config).evaluate(c, result).approved).toBe(true);
  });

  it("does not apply entry limits to a requested full CLOSE", () => {
    const c = context(filters());
    c.position_state = { side: "long", quantity: 0.5, entryPrice: 100_000, markPrice: 100_000, leverage: 2, unrealizedPnl: 0, realizedPnl: 0 };
    const result = new StrategyPlanner(config).plan(c, { ...signal("LONG"), bias: "CLOSE" });
    const evaluated = new RiskEngine(config).evaluate(c, result);
    expect(evaluated.approved).toBe(true);
    expect(evaluated.executionPlan!.quantity).toBe(0.5);
  });

  it("preserves legacy LOT_SIZE-only filter behavior", () => {
    const c = context({ tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 });
    expect(new RiskEngine(config).evaluate(c, planning(c, "LONG")).approved).toBe(true);
  });
});
