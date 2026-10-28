import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { config } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { MarketIngestor } from "./marketIngestor.js";

const minute = 60_000;
const start = Date.UTC(2020, 0, 1);
type Bar = { openTime: number; closeTime: number; close: number; high: number; low: number; volume: number };
type Inspect = { candleHistory: Bar[]; handleMarketMessage: (raw: string) => Promise<void>; connectMarketSocket: () => void };

const bar = (i: number, volume = 100): Bar => ({
  openTime: start + i * minute, closeTime: start + (i + 1) * minute - 1,
  close: 100, high: 100, low: 100, volume
});
const frame = (i: number, closed = true) => ({ stream: "btcusdt@kline_1m", data: {
  e: "kline", E: start + (i + 1) * minute, k: {
    t: start + i * minute, T: start + (i + 1) * minute - 1,
    c: "100", h: "100", l: "100", v: "100", x: closed
  }
} });

afterEach(() => { vi.restoreAllMocks(); });

async function fixture(history: Bar[]) {
  const client = new BinanceFuturesClient("https://unused.invalid", "wss://unused.invalid", "", "", {} as Logger);
  vi.spyOn(client, "getSymbolFilters").mockResolvedValue(undefined);
  vi.spyOn(client, "getRecentKlines").mockResolvedValue(history);
  const snapshot = { symbol: "BTCUSDT", markPrice: 100, lastPrice: 100, openInterest: 1 } as MarketSnapshot;
  vi.spyOn(client, "composeInitialMarketSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(client, "getMarkPrice").mockResolvedValue({ markPrice: 100, indexPrice: 100, fundingRate: 0, nextFundingTime: 0 });
  vi.spyOn(client, "getOpenInterest").mockResolvedValue(1);
  vi.spyOn(client, "getTopTraderLongShortRatio").mockResolvedValue(1);
  const onMarket = vi.fn();
  const service = new MarketIngestor({ ...config, tradingMode: "paper" }, client, { warn: vi.fn() } as unknown as Logger,
    { onMarket, onAccount: vi.fn(), onPosition: vi.fn() });
  const inspect = service as unknown as Inspect;
  vi.spyOn(inspect, "connectMarketSocket").mockImplementation(() => {});
  try { await service.start(); } finally { await service.stop(); }
  return { service, inspect, onMarket };
}

describe("closed candle identity", () => {
  it("excludes a forming REST candle and records its final websocket row once", async () => {
    vi.spyOn(Date, "now").mockReturnValue(start + 20 * minute + 30_000);
    const { inspect, onMarket } = await fixture([...Array.from({ length: 20 }, (_, i) => bar(i)), bar(20, 1)]);
    expect(inspect.candleHistory).toHaveLength(20);
    await inspect.handleMarketMessage(JSON.stringify(frame(20)));
    expect(inspect.candleHistory).toHaveLength(21);
    expect(inspect.candleHistory.at(-1)).toEqual(bar(20));
    expect(onMarket.mock.calls.at(-1)?.[0].volumeAcceleration).toBe(1);
    await inspect.handleMarketMessage(JSON.stringify(frame(20)));
    expect(inspect.candleHistory).toHaveLength(21);
    expect(onMarket.mock.calls.at(-1)?.[0].volumeAcceleration).toBe(1);
  });

  it("replaces a seeded closed candle by open time and preserves its exchange close time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(start + 22 * minute);
    const { inspect } = await fixture(Array.from({ length: 21 }, (_, i) => bar(i)));
    const event = frame(20);
    event.data.E += 3_000;
    event.data.k.v = "120";
    await inspect.handleMarketMessage(JSON.stringify(event));
    expect(inspect.candleHistory).toHaveLength(21);
    expect(inspect.candleHistory.at(-1)).toEqual({ ...bar(20), volume: 120 });
    await inspect.handleMarketMessage(JSON.stringify(frame(21)));
    expect(inspect.candleHistory).toHaveLength(22);
  });

  it("keeps forming updates out of completed history", async () => {
    vi.spyOn(Date, "now").mockReturnValue(start + 20 * minute + 30_000);
    const { inspect, onMarket } = await fixture(Array.from({ length: 20 }, (_, i) => bar(i)));
    await inspect.handleMarketMessage(JSON.stringify(frame(20, false)));
    expect(inspect.candleHistory).toHaveLength(20);
    expect(onMarket.mock.calls.at(-1)?.[0].lastPrice).toBe(100);
  });

  it("ignores a final candle older than the retained tail without rolling back the snapshot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(start + 25 * minute);
    const { inspect, onMarket } = await fixture([bar(20), bar(21)]);
    const calls = onMarket.mock.calls.length;
    await inspect.handleMarketMessage(JSON.stringify(frame(19)));
    expect(inspect.candleHistory).toEqual([bar(20), bar(21)]);
    expect(onMarket).toHaveBeenCalledTimes(calls);
  });

  it("preserves the retention bound when replacing and appending closed candles", async () => {
    vi.spyOn(Date, "now").mockReturnValue(start + 250 * minute);
    const { inspect } = await fixture(Array.from({ length: 240 }, (_, i) => bar(i)));
    await inspect.handleMarketMessage(JSON.stringify(frame(239)));
    expect(inspect.candleHistory).toHaveLength(240);
    expect(inspect.candleHistory[0]).toEqual(bar(0));
    await inspect.handleMarketMessage(JSON.stringify(frame(240)));
    expect(inspect.candleHistory).toHaveLength(240);
    expect(inspect.candleHistory[0]).toEqual(bar(1));
    expect(inspect.candleHistory.at(-1)).toEqual(bar(240));
  });

  it.each([
    ["t", undefined], ["t", NaN], ["t", Infinity], ["t", -1], ["t", 1.5], ["t", "123"],
    ["T", undefined], ["T", Infinity], ["T", -1], ["T", 1.5], ["T", start],
    ["T", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects an invalid candle identity %s=%s", async (key, value) => {
    vi.spyOn(Date, "now").mockReturnValue(start + 25 * minute);
    const { inspect } = await fixture([bar(20)]);
    const event = frame(21);
    (event.data.k as unknown as Record<string, unknown>)[key as string] = value;
    await expect(inspect.handleMarketMessage(JSON.stringify(event))).rejects.toThrow("candle interval");
    expect(inspect.candleHistory).toEqual([bar(20)]);
  });
});
