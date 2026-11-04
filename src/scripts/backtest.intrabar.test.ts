import { afterEach, expect, it, vi } from "vitest";
import type { PersistedTradeRecord } from "../domain/types.js";

const observed = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), trades: [] as PersistedTradeRecord[] }));

vi.mock("../logger.js", () => ({ logger: { info: observed.info, error: observed.error } }));
vi.mock("../infra/binance/binanceFuturesClient.js", () => ({
  BinanceFuturesClient: class {
    async getSymbolFilters() { return { tickSize: 0.0001, stepSize: 0.001, minQty: 0.001 }; }
  }
}));
vi.mock("../services/brokers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/brokers.js")>();
  return {
    ...actual,
    PaperBroker: class extends actual.PaperBroker {
      override async execute(...args: Parameters<InstanceType<typeof actual.PaperBroker>["execute"]>) {
        const result = await super.execute(...args);
        if (result.tradeRecord) observed.trades.push(result.tradeRecord);
        return result;
      }
      override async onHistoricalCandle(...args: Parameters<InstanceType<typeof actual.PaperBroker>["onHistoricalCandle"]>) {
        const result = await super.onHistoricalCandle(...args);
        if (result?.tradeRecord) observed.trades.push(result.tradeRecord);
        return result;
      }
    }
  };
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("closes an existing replay position when a stop crosses intrabar and the close recovers", async () => {
  const start = Date.UTC(2020, 0, 1);
  const rows = Array.from({ length: 62 }, (_, i) => {
    const price = i < 60 ? "100" : "101";
    return [start + i * 60_000, price, price, i === 61 ? "99" : price, price, i === 60 ? "100" : "1",
      start + (i + 1) * 60_000 - 1, "0", 1, "0", "0", "0"];
  });
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows)));
  vi.stubGlobal("fetch", fetchMock);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("unexpected process exit"); });
  await import("./backtest.js");
  await vi.waitFor(() => expect(observed.info).toHaveBeenCalledWith(expect.anything(), "Backtest completed"));
  expect(exit).not.toHaveBeenCalled();
  expect(observed.error).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const opened = observed.trades.find((trade) => trade.status === "open");
  const closed = observed.trades.find((trade) => trade.exitReason === "stop_loss");
  expect(opened?.openedAt).toBe(rows[60]![6]);
  expect(closed?.closedAt).toBe(rows[61]![6]);
  expect(closed?.holdingMinutes).toBe(1);
  expect(closed?.netPnl).toBeLessThan(0);
  expect(closed?.remainingQuantity).toBe(0);
  expect(observed.info.mock.calls.at(-1)?.[0]).toMatchObject({ entries: 1, exits: 1, losses: 1, wins: 0 });
});
