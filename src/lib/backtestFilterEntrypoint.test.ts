import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getSymbolFilters: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("../infra/binance/binanceFuturesClient.js", () => ({
  BinanceFuturesClient: class { getSymbolFilters = mocks.getSymbolFilters; }
}));
vi.mock("../logger.js", () => ({ logger: { info: mocks.info, error: mocks.error } }));
let directory: string | undefined;
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks();
  if (directory) await rm(directory, { recursive: true });
  directory = undefined;
});

describe("backtest entrypoint filter selection", () => {
  it("uses the explicit snapshot for replay and reports it without requesting exchangeInfo", async () => {
    vi.resetModules();
    directory = await mkdtemp(join(tmpdir(), "backtest-entrypoint-"));
    const path = join(directory, "filters.json");
    const filters = { tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 };
    await writeFile(path, JSON.stringify({ symbol: "BTCUSDT", filters }));
    vi.stubEnv("BACKTEST_FILTERS_FILE", path); vi.stubEnv("SYMBOL", "BTCUSDT");
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/fapi/v1/klines");
      const start = Number(url.searchParams.get("endTime")) - 65 * 60_000;
      return new Response(JSON.stringify(Array.from({ length: 65 }, (_, index) => [
        start + index * 60_000, "100000", "100100", "99900", "100000", "1", start + index * 60_000 + 59_999,
        "0", 0, "0", "0", "0"
      ])));
    });
    vi.stubGlobal("fetch", fetch);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("../scripts/backtest.js");
    await vi.waitFor(() => expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ filterSource: `snapshot:${path}`, filters }), "Backtest completed"));
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.getSymbolFilters).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
  });
  it("fails before fetching candles when the explicit snapshot is unavailable", async () => {
    vi.resetModules(); vi.stubEnv("BACKTEST_FILTERS_FILE", "/missing/explicit-filter-snapshot.json");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("../scripts/backtest.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.getSymbolFilters).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(expect.anything(), "Backtest failed");
  });
});
