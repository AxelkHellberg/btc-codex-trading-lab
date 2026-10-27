import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DecisionContext } from "../domain/types.js";

const observed = vi.hoisted(() => ({
  contexts: [] as DecisionContext[],
  info: vi.fn(),
  error: vi.fn()
}));

vi.mock("../config.js", () => ({ config: {
  symbol: "BTCUSDT", paperStartingBalance: 10_000,
  binance: { restBaseUrl: "https://exchange.invalid", wsBaseUrl: "wss://exchange.invalid" }
} }));
vi.mock("../logger.js", () => ({ logger: { info: observed.info, error: observed.error } }));
vi.mock("../infra/binance/binanceFuturesClient.js", () => ({
  BinanceFuturesClient: class {
    async getSymbolFilters() { return { tickSize: 0.1, stepSize: 0.001, minQty: 0.001 }; }
  }
}));
vi.mock("../services/brokers.js", () => ({ PaperBroker: class {} }));
vi.mock("../services/strategyPlanner.js", () => ({
  StrategyPlanner: class {
    plan(context: DecisionContext) { observed.contexts.push(context); return {}; }
  }
}));
vi.mock("../services/riskEngine.js", () => ({
  RiskEngine: class { evaluate() { return { approved: false }; } }
}));

beforeAll(async () => {
  const start = Date.UTC(2026, 0, 1);
  const candles = Array.from({ length: 1_445 }, (_, index) => [
    start + index * 60_000, "100", index === 0 ? "500" : index === 1_444 ? "1000" : "110",
    index === 0 ? "1" : index === 1_444 ? "0.5" : "90", "100", "10",
    start + (index + 1) * 60_000 - 1, "0", 1, "0", "0", "0"
  ]);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(candles))));
  await import("./backtest.js");
  await vi.waitFor(() => expect(observed.info).toHaveBeenCalledWith(expect.any(Object), "Backtest completed"));
  expect(observed.error).not.toHaveBeenCalled();
  expect(observed.contexts).toHaveLength(1_385);
});

afterAll(() => vi.unstubAllGlobals());

function contextAt(index: number) { return observed.contexts[index - 60]!; }

describe("backtest intraday levels", () => {
  it("retains a high and low more than one hour old in snapshots and decision key levels", () => {
    const context = contextAt(120);
    expect(context.market_snapshot.intradayHigh).toBe(500);
    expect(context.market_snapshot.intradayLow).toBe(1);
    expect(context.context_summary.key_levels).toEqual({ intraday_high: 500, intraday_low: 1 });
    expect(context.market_snapshot.distanceFromIntradayHighPct).toBe(-80);
    expect(context.market_snapshot.distanceFromIntradayLowPct).toBe(9_900);
  });

  it("includes exactly 1,440 one-minute bars and drops expired extremes", () => {
    expect(contextAt(1_439).market_snapshot.intradayHigh).toBe(500);
    expect(contextAt(1_439).market_snapshot.intradayLow).toBe(1);
    expect(contextAt(1_440).market_snapshot.intradayHigh).toBe(110);
    expect(contextAt(1_440).market_snapshot.intradayLow).toBe(90);
  });

  it("uses available early history and never looks ahead at future extremes", () => {
    expect(contextAt(60).market_snapshot.intradayHigh).toBe(500);
    expect(contextAt(1_443).context_summary.key_levels).toEqual({ intraday_high: 110, intraday_low: 90 });
    expect(contextAt(1_444).context_summary.key_levels).toEqual({ intraday_high: 1_000, intraday_low: 0.5 });
  });
});
