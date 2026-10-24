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

describe("closed-candle backtest cutoff", () => {
  it.each([0, 30_000, 59_999])("excludes unfinished rows at minute offset %i", async (offset) => {
    vi.mocked(Date.now).mockReturnValue(now + offset);
    const completed = rows(61);
    const unfinished = [now, "100", "101", "99", "100", "1", now + 59_999, "100", 1, "1", "100", "0"];
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => [...completed, unfinished] });
    vi.stubGlobal("fetch", fetchMock);
    await import("./backtest.js");
    await vi.waitFor(() => expect(dependencies.info).toHaveBeenCalled());
    const requested = new URL(fetchMock.mock.calls[0]![0]);
    expect(requested.searchParams.get("endTime")).toBe(String(now - 1));
    expect(dependencies.onMarketSnapshot).toHaveBeenCalledOnce();
    expect(dependencies.onMarketSnapshot.mock.calls[0]![0].timestamp).toBe(now - 1);
    expect(dependencies.evaluate).toHaveBeenCalledOnce();
    expect(dependencies.evaluate.mock.calls[0]![0].market_snapshot.timestamp).toBe(now - 1);
    expect(dependencies.info).toHaveBeenCalledWith(expect.objectContaining({
      receivedCandles: 61, evaluatedBars: 1
    }), "Backtest completed");
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("fails if removing the unfinished row leaves only warmup history", async () => {
    const unfinished = [now, "100", "101", "99", "100", "1", now + 59_999, "100", 1, "1", "100", "0"];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => [...rows(60), unfinished] }));
    await import("./backtest.js");
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(dependencies.info).not.toHaveBeenCalled();
    expect(dependencies.getSymbolFilters).not.toHaveBeenCalled();
    expect(dependencies.onMarketSnapshot).not.toHaveBeenCalled();
    expect(dependencies.error.mock.calls[0]![0].error.message).toContain("received 60");
  });

  it("keeps one cutoff when paginated downloads cross another minute", async () => {
    const completed = rows(1531);
    const unfinished = [now, "100", "101", "99", "100", "1", now + 59_999, "100", 1, "1", "100", "0"];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ json: async () => completed.slice(0, 1500) })
      .mockImplementationOnce(async () => {
        vi.mocked(Date.now).mockReturnValue(now + 120_000);
        return { json: async () => [...completed.slice(1500), unfinished] };
      });
    vi.stubGlobal("fetch", fetchMock);
    await import("./backtest.js");
    await vi.waitFor(() => expect(dependencies.info).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls) {
      expect(new URL(url).searchParams.get("endTime")).toBe(String(now - 1));
    }
    expect(dependencies.onMarketSnapshot).toHaveBeenCalledTimes(1471);
    expect(dependencies.onMarketSnapshot.mock.calls.every(([snapshot]) => snapshot.timestamp <= now - 1)).toBe(true);
    expect(dependencies.evaluate).toHaveBeenCalledTimes(1471);
    expect(dependencies.info).toHaveBeenCalledWith(expect.objectContaining({
      receivedCandles: 1531, evaluatedBars: 1471
    }), "Backtest completed");
  });
});
