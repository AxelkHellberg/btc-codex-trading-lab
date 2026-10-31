import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import type { DecisionContext } from "../domain/types.js";
import { StrategyPlanner } from "../services/strategyPlanner.js";
import { loadBacktestFilters } from "./backtestFilters.js";

const rules = { tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 };
const directories: string[] = [];
const file = async (value: unknown, raw = false) => {
  const directory = await mkdtemp(join(tmpdir(), "backtest-filters-"));
  directories.push(directory);
  const path = join(directory, "filters.json");
  await writeFile(path, raw ? String(value) : JSON.stringify(value));
  return path;
};
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("backtest filter snapshots", () => {
  it("loads exact fixed rules without querying current exchange metadata", async () => {
    const path = await file({ symbol: "BTCUSDT", filters: rules });
    const client = { getSymbolFilters: vi.fn().mockRejectedValue(new Error("offline")) };
    expect(await loadBacktestFilters("BTCUSDT", client, path)).toEqual({ source: `snapshot:${path}`, filters: rules });
    expect(client.getSymbolFilters).not.toHaveBeenCalled();
  });
  it("keeps planner output stable despite a changing live filter source", async () => {
    const path = await file({ symbol: "BTCUSDT", filters: rules });
    const client = { getSymbolFilters: vi.fn().mockResolvedValue(rules) };
    const plan = async () => {
      const { filters } = await loadBacktestFilters("BTCUSDT", client, path);
      const context = {
        market_snapshot: { markPrice: 100_000, bestBid: 99_999, bestAsk: 100_001, filters },
        account_state: { equity: 10_000, walletBalance: 10_000, availableBalance: 10_000 },
        position_state: { side: "flat", quantity: 0 },
        context_summary: { regime: "trend_up", trend_bias: "bullish" }
      } as DecisionContext;
      return new StrategyPlanner(config).plan(context, {
        bias: "LONG", confidence: 0.8, setup_type: "breakout", invalidation_price: 99_000,
        holding_horizon_minutes: 90, reasoning_summary: "fixed historical fixture"
      });
    };
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const first = await plan();
      client.getSymbolFilters.mockResolvedValue({ tickSize: 100, stepSize: 1, minQty: 1, minNotional: 100_000 });
      expect(await plan()).toEqual(first);
      expect(first.plan?.quantity).toBeGreaterThan(0);
      expect(client.getSymbolFilters).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("labels the default live source and records the actual rules", async () => {
    const client = { getSymbolFilters: vi.fn().mockResolvedValue(rules) };
    expect(await loadBacktestFilters("BTCUSDT", client)).toEqual({ source: "current-exchangeInfo", filters: rules });
    expect(client.getSymbolFilters).toHaveBeenCalledExactlyOnceWith("BTCUSDT");
  });
  it("preserves optional quantity limits used by the market-filter contract", async () => {
    const extended = { ...rules, maxQty: 100, marketLotSize: { minQty: 0, maxQty: 50, stepSize: 0 } };
    expect((await loadBacktestFilters("BTCUSDT", { getSymbolFilters: vi.fn() }, await file({ symbol: "BTCUSDT", filters: extended }))).filters).toEqual(extended);
  });
  it.each([
    { symbol: "ETHUSDT", filters: rules },
    { symbol: "BTCUSDT", filters: { ...rules, tickSize: 0 } },
    { symbol: "BTCUSDT", filters: { ...rules, stepSize: -1 } },
    { symbol: "BTCUSDT", filters: { ...rules, minQty: "0.001" } },
    { symbol: "BTCUSDT", filters: { ...rules, minNotional: -5 } },
    { symbol: "BTCUSDT", filters: { ...rules, typo: 1 } },
    { symbol: "BTCUSDT" }
  ])("rejects invalid explicit snapshots without fallback (%j)", async (snapshot) => {
    const client = { getSymbolFilters: vi.fn().mockResolvedValue(rules) };
    await expect(loadBacktestFilters("BTCUSDT", client, await file(snapshot))).rejects.toThrow();
    expect(client.getSymbolFilters).not.toHaveBeenCalled();
  });
  it.each(["", "not-json"]) ("rejects empty or malformed JSON (%s)", async (raw) => {
    await expect(loadBacktestFilters("BTCUSDT", { getSymbolFilters: vi.fn() }, await file(raw, true))).rejects.toThrow();
  });
  it("does not silently use live rules for a missing or blank file", async () => {
    const client = { getSymbolFilters: vi.fn() };
    await expect(loadBacktestFilters("BTCUSDT", client, "")).rejects.toThrow(/must name/);
    await expect(loadBacktestFilters("BTCUSDT", client, "/missing/snapshot.json")).rejects.toThrow();
    expect(client.getSymbolFilters).not.toHaveBeenCalled();
  });
  it("fails when no valid current rules are available", async () => {
    await expect(loadBacktestFilters("BTCUSDT", { getSymbolFilters: vi.fn().mockResolvedValue(undefined) })).rejects.toThrow();
  });
});
