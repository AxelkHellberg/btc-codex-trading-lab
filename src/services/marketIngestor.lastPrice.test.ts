import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";

const sockets = vi.hoisted(() => ({ all: [] as EventEmitter[] }));
vi.mock("ws", () => ({ default: class extends EventEmitter {
  constructor() { super(); sockets.all.push(this); }
  close() {}
} }));

import { MarketIngestor } from "./marketIngestor.js";

describe("MarketIngestor last traded price", () => {
  afterEach(() => { vi.useRealTimers(); sockets.all.length = 0; });

  async function setup() {
    vi.useFakeTimers();
    const initial = {
      symbol: "BTCUSDT", markPrice: 101, indexPrice: 101, lastPrice: 100,
      openInterest: 10, volume1m: 1, timestamp: Date.now()
    } as MarketSnapshot;
    const client = {
      getSymbolFilters: vi.fn().mockResolvedValue({}),
      composeInitialMarketSnapshot: vi.fn().mockResolvedValue(initial),
      getRecentKlines: vi.fn().mockResolvedValue(Array.from({ length: 60 }, () => ({
        close: 99, high: 100, low: 98, volume: 1, closeTime: Date.now()
      }))),
      getMarkPrice: vi.fn().mockResolvedValue({ markPrice: 101, indexPrice: 101, fundingRate: 0.001, nextFundingTime: 1000 }),
      getOpenInterest: vi.fn().mockResolvedValue(10),
      getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1),
      getCombinedMarketStreamUrl: vi.fn().mockReturnValue("wss://example.invalid/stream"),
      stopUserStreamKeepalive: vi.fn()
    };
    const onMarket = vi.fn();
    const warn = vi.fn();
    const ingestor = new MarketIngestor({ symbol: "BTCUSDT", tradingMode: "paper" } as AppConfig,
      client as unknown as BinanceFuturesClient, { warn } as unknown as Logger,
      { onMarket, onAccount: vi.fn(), onPosition: vi.fn() });
    await ingestor.start();
    const latest = () => onMarket.mock.calls.at(-1)![0] as MarketSnapshot;
    const send = async (data: unknown) => {
      sockets.all[0]!.emit("message", Buffer.from(JSON.stringify({ stream: "fixture", data })));
      await vi.advanceTimersByTimeAsync(0);
    };
    return { ingestor, latest, send, warn, client };
  }

  it("keeps the latest candle close across mark frames and supplemental refreshes", async () => {
    const { ingestor, latest, send, warn, client } = await setup();
    await send({ e: "kline", E: 1, k: { c: "100", h: "100", l: "99", v: "2", x: false } });
    const traded = latest();
    await send({ e: "markPriceUpdate", E: 2, p: "102", i: "101.5", r: "0.002", T: 2000 });
    expect(latest()).toMatchObject({ lastPrice: 100, markPrice: 102, indexPrice: 101.5, fundingRate: 0.002, nextFundingTime: 2000 });
    client.getMarkPrice.mockResolvedValue({ markPrice: 103, indexPrice: 102.5, fundingRate: 0.003, nextFundingTime: 3000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(latest()).toMatchObject({ lastPrice: 100, markPrice: 103, indexPrice: 102.5 });
    for (const key of ["priceChangePct1m", "priceChangePct5m", "priceChangePct15m", "priceChangePct1h", "emaFast", "emaMedium", "trendStrengthPct"] as const) {
      expect(latest()[key]).toBe(traded[key]);
    }
    expect(warn).not.toHaveBeenCalled();
    await ingestor.stop();
  });

  it("accepts subsequent candle prices and does not replace them with book or mark prices", async () => {
    const { ingestor, latest, send } = await setup();
    await send({ e: "kline", E: 1, k: { c: "104", h: "105", l: "99", v: "3", x: true } });
    expect(latest()).toMatchObject({ lastPrice: 104, volume1m: 3 });
    await send({ e: "bookTicker", E: 2, b: "106", a: "107" });
    await send({ e: "markPriceUpdate", E: 3, p: "108", i: "107", r: "0.001", T: 4000 });
    expect(latest()).toMatchObject({ lastPrice: 104, markPrice: 108, bestBid: 106, bestAsk: 107 });
    await ingestor.stop();
  });
});
