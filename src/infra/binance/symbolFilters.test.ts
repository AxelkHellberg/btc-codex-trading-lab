import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { config } from "../../config.js";
import type { DecisionContext, SymbolFilters } from "../../domain/types.js";
import { RiskEngine } from "../../services/riskEngine.js";
import { StrategyPlanner } from "../../services/strategyPlanner.js";
import { MarketIngestor } from "../../services/marketIngestor.js";
import { BinanceFuturesClient } from "./binanceFuturesClient.js";

const rules = () => [
  { filterType: "PRICE_FILTER", tickSize: "0.1" },
  { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "0.001", maxQty: "100" },
  { filterType: "MIN_NOTIONAL", notional: "5" }
];
const clientWith = (value: unknown) => {
  const client = new BinanceFuturesClient("https://unused.invalid", "", "", "", {} as Logger);
  vi.spyOn(client as unknown as { publicGet(): Promise<unknown> }, "publicGet").mockResolvedValue(value);
  return client;
};
const response = (filters: unknown) => ({ symbols: [{ symbol: "BTCUSDT", filters }] });
const context = (filters: SymbolFilters | undefined) => ({
  market_snapshot: { markPrice: 100_000, volumeAcceleration: 1.4, filters },
  account_state: { equity: 10_000, openOrders: 0 },
  position_state: { side: "flat", quantity: 0 },
  risk_state: { withinDailyLossLimit: true, withinWeeklyDrawdown: true, cooldownActive: false },
  context_summary: { regime: "trend_up", trend_bias: "bullish" }
} as DecisionContext);
const signal = { bias: "LONG", confidence: 0.66, setup_type: "breakout", invalidation_price: 99_000,
  holding_horizon_minutes: 90, reasoning_summary: "fixture" } as const;

describe("required exchange rule contract", () => {
  it.each([null, {}, { symbols: null }, { symbols: [] }, response(null), response([])])(
    "rejects absent symbol/filter metadata: %j", async value => {
      await expect(clientWith(value).getSymbolFilters("BTCUSDT")).rejects.toThrow(/BTCUSDT/);
    }
  );
  it.each(["PRICE_FILTER", "LOT_SIZE"])("rejects missing %s", async type => {
    await expect(clientWith(response(rules().filter(rule => rule.filterType !== type)))
      .getSymbolFilters("BTCUSDT")).rejects.toThrow(type);
  });
  it.each(["", "NaN", "Infinity", "0", "-1"])("rejects malformed tick size %j", async tickSize => {
    const filters = rules(); filters[0]!.tickSize = tickSize;
    await expect(clientWith(response(filters)).getSymbolFilters("BTCUSDT")).rejects.toThrow(/tickSize/);
  });
  it.each(["stepSize", "minQty"] as const)("rejects missing LOT_SIZE.%s", async field => {
    const filters = rules(); delete filters[1]![field];
    await expect(clientWith(response(filters)).getSymbolFilters("BTCUSDT")).rejects.toThrow(field);
  });
  it.each([
    { filterType: "LOT_SIZE", stepSize: "0.001", minQty: "1", maxQty: "0.1" },
    { filterType: "MARKET_LOT_SIZE", stepSize: "0", minQty: "0.001", maxQty: "100" },
    { filterType: "MIN_NOTIONAL", notional: "NaN" },
    { filterType: "MIN_NOTIONAL", notional: "0" }
  ])("rejects incomplete or invalid supplied limits: %j", async bad => {
    const filters = rules().filter(rule => rule.filterType !== bad.filterType);
    await expect(clientWith(response([...filters, bad])).getSymbolFilters("BTCUSDT")).rejects.toThrow();
  });
  it("rejects duplicate required rules instead of selecting the first", async () => {
    await expect(clientWith(response([...rules(), rules()[0]] )).getSymbolFilters("BTCUSDT"))
      .rejects.toThrow(/PRICE_FILTER/);
  });
  it("retains valid rules and optional notional semantics", async () => {
    expect(await clientWith(response(rules())).getSymbolFilters("BTCUSDT"))
      .toEqual({ tickSize: 0.1, stepSize: 0.001, minQty: 0.001, maxQty: 100, minNotional: 5 });
    expect(await clientWith(response(rules().slice(0, 2))).getSymbolFilters("BTCUSDT"))
      .toMatchObject({ tickSize: 0.1, stepSize: 0.001, minQty: 0.001 });
  });
  it("does not initialize market state after metadata validation fails", async () => {
    const client = clientWith(response([]));
    const compose = vi.spyOn(client, "composeInitialMarketSnapshot");
    const onMarket = vi.fn();
    const ingestor = new MarketIngestor(config, client, {} as Logger, { onMarket, onAccount: vi.fn(), onPosition: vi.fn() });
    await expect(ingestor.start()).rejects.toThrow();
    expect(compose).not.toHaveBeenCalled();
    expect(onMarket).not.toHaveBeenCalled();
  });
  it.each([undefined, { tickSize: 0, stepSize: 0.001, minQty: 0.001 },
    { tickSize: 0.1, stepSize: NaN, minQty: 0.001 }])("rejects entry metadata even when startup/planner is bypassed: %j", filters => {
    const c = context(filters);
    const planner = new StrategyPlanner(config);
    expect(planner.plan(c, signal).reasons.join(" ")).toMatch(/exchange.*filter/i);
    const valid = planner.plan(context({ tickSize: 0.1, stepSize: 0.001, minQty: 0.001 }), signal);
    expect(new RiskEngine(config).evaluate(c, valid).approved).toBe(false);
  });
  it("keeps CLOSE available without entry metadata", () => {
    const c = context(undefined);
    c.position_state = { side: "long", quantity: 0.02, entryPrice: 100_000, markPrice: 100_000,
      leverage: 2, unrealizedPnl: 0, realizedPnl: 0 };
    const plan = new StrategyPlanner(config).plan(c, { ...signal, bias: "CLOSE" });
    expect(new RiskEngine(config).evaluate(c, plan).approved).toBe(true);
  });
});
