import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  info: vi.fn(), error: vi.fn(), getSymbolFilters: vi.fn(), onMarketSnapshot: vi.fn(),
  plan: vi.fn(), evaluate: vi.fn()
}));
vi.mock("../config.js", () => ({ config: {
  symbol: "BTCUSDT", paperStartingBalance: 10_000,
  binance: { restBaseUrl: "https://fixture.invalid", wsBaseUrl: "wss://fixture.invalid" }
} }));
vi.mock("../logger.js", () => ({ logger: dependencies }));
vi.mock("../infra/binance/binanceFuturesClient.js", () => ({
  BinanceFuturesClient: class { getSymbolFilters = dependencies.getSymbolFilters; }
}));
vi.mock("../services/brokers.js", () => ({
  PaperBroker: class { onMarketSnapshot = dependencies.onMarketSnapshot; }
}));
vi.mock("../services/strategyPlanner.js", () => ({
  StrategyPlanner: class { plan = dependencies.plan; }
}));
vi.mock("../services/riskEngine.js", () => ({
  RiskEngine: class { evaluate = dependencies.evaluate; }
}));

const now = Date.UTC(2026, 9, 24, 15);
const rows = (count: number) => Array.from({ length: count }, (_, index) => [
  now - (count - index) * 60_000, "100", "101", "99", "100", "1",
  now - (count - index - 1) * 60_000 - 1, "100", 1, "1", "100", "0"
]);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("BACKTEST_DAYS", "1");
  vi.stubEnv("BACKTEST_INITIAL_BALANCE", "10000");
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  dependencies.evaluate.mockReturnValue({ approved: false });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("backtest history requirement", () => {
  it.each([0, 1, 59, 60])("rejects %i candles before exchange filter lookup", async (count) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => rows(count) }));
    await import("./backtest.js");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(dependencies.info).not.toHaveBeenCalled();
    expect(dependencies.getSymbolFilters).not.toHaveBeenCalled();
    expect(dependencies.onMarketSnapshot).not.toHaveBeenCalled();
    const error = dependencies.error.mock.calls[0]![0].error as Error;
    expect(error.message).toContain("BTCUSDT");
    expect(error.message).toContain("1m");
    expect(error.message).toContain(`received ${count}`);
    expect(error.message).toContain("at least 61");
    expect(error.message).toContain(String(now - 86_400_000));
    expect(error.message).toContain(String(now - 1));
  });

  it.each([61, 62])("reports coverage for a valid %i-candle zero-trade replay", async (count) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => rows(count) }));
    await import("./backtest.js");
    await vi.waitFor(() => expect(dependencies.info).toHaveBeenCalled());
    expect(process.exit).not.toHaveBeenCalled();
    expect(dependencies.error).not.toHaveBeenCalled();
    expect(dependencies.getSymbolFilters).toHaveBeenCalledOnce();
    expect(dependencies.onMarketSnapshot).toHaveBeenCalledTimes(count - 60);
    expect(dependencies.evaluate).toHaveBeenCalledTimes(count - 60);
    expect(dependencies.info).toHaveBeenCalledWith(expect.objectContaining({
      receivedCandles: count, evaluatedBars: count - 60, entries: 0, exits: 0
    }), "Backtest completed");
  });
});
