import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketIngestor } from "../services/marketIngestor.js";

const fixtures = vi.hoisted(() => ({
  snapshots: [] as any[], contexts: [] as any[], info: vi.fn(), error: vi.fn()
}));
vi.mock("../config.js", () => ({config: {
  symbol: "BTCUSDT", paperStartingBalance: 1000, binance: {restBaseUrl: "https://unused.invalid", wsBaseUrl: ""}
}}));
vi.mock("../logger.js", () => ({logger: {info: fixtures.info, error: fixtures.error}}));
vi.mock("../infra/binance/binanceFuturesClient.js", () => ({BinanceFuturesClient: class {
  async getSymbolFilters() { return undefined; }
}}));
vi.mock("../services/brokers.js", () => ({PaperBroker: class {
  async onMarketSnapshot(snapshot: unknown) { fixtures.snapshots.push(snapshot); return null; }
  getState() { return {accountState: {equity: 1000}, positionState: {side: "flat"}}; }
}}));
vi.mock("../services/strategyPlanner.js", () => ({StrategyPlanner: class {
  plan(context: unknown) { fixtures.contexts.push(context); return {}; }
}}));
vi.mock("../services/riskEngine.js", () => ({RiskEngine: class {
  evaluate() { return {approved: false}; }
}}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("backtest distance-to-high contract", () => {
  it.each([100, 110, 90])("matches runtime distances at close %s", async (close) => {
    vi.resetModules();
    fixtures.snapshots.length = 0;
    fixtures.contexts.length = 0;
    const rows = Array.from({length: 61}, (_, i) => [
      i * 60_000, "100", "110", "90", String(i === 60 ? close : 100), "10",
      (i + 1) * 60_000 - 1, "0", 0, "0", "0", "0"
    ]);
    const fetchMock = vi.fn(async () => ({json: async () => rows}));
    vi.stubGlobal("fetch", fetchMock);
    await import("./backtest.js");
    await vi.waitFor(() => expect(fixtures.info).toHaveBeenCalledWith(expect.any(Object), "Backtest completed"));
    expect(fixtures.error).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fixtures.snapshots).toHaveLength(1);
    expect(fixtures.contexts).toHaveLength(1);
    const replay = fixtures.snapshots[0];
    const runtime = new MarketIngestor({} as any, {} as any, {} as any, {} as any);
    (runtime as any).candleHistory = rows.map(row => ({close: Number(row[4]), high: 110, low: 90, volume: 10}));
    const live = (runtime as any).applyDerivedMetrics(replay, close, 10, 110, 90);
    expect(replay.distanceFromIntradayHighPct).toBeCloseTo(live.distanceFromIntradayHighPct);
    expect(replay.distanceFromIntradayHighPct).toBeGreaterThanOrEqual(0);
    expect(replay.distanceFromIntradayLowPct).toBeCloseTo(live.distanceFromIntradayLowPct);
    expect(fixtures.contexts[0].market_snapshot).toEqual(replay);
  });
});
