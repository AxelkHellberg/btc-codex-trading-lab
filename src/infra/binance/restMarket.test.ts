import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BinanceFuturesClient } from "./binanceFuturesClient.js";

const client = () => new BinanceFuturesClient(
  "https://offline.invalid", "wss://offline.invalid", "fixture", "fixture",
  { warn: vi.fn() } as unknown as Logger
);
const mark = { markPrice: "100", indexPrice: "101", lastFundingRate: "-0.0001", nextFundingTime: 1800000000000 };
const candle = [60000, "100", "102", "99", "101", "2", 119999];
const response = (value: unknown) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
afterEach(() => vi.unstubAllGlobals());

describe("public Binance REST market data", () => {
  it("maps coherent recent candles and accepts an empty history", async () => {
    response([candle]);
    await expect(client().getRecentKlines("BTCUSDT", "1m", 240)).resolves.toEqual([
      { openTime: 60000, high: 102, low: 99, close: 101, volume: 2, closeTime: 119999 }
    ]);
    response([]);
    await expect(client().getRecentKlines("BTCUSDT", "1m", 240)).resolves.toEqual([]);
  });

  it.each([null, {}, [null], [[]], [[0, "1"]]])("rejects malformed candle envelopes (%j)", async (value) => {
    response(value);
    await expect(client().getRecentKlines("BTCUSDT", "1m", 240)).rejects.toThrow(/Invalid Binance klines/);
  });

  it.each([
    [0, -1], [0, 1.5], [0, "60000"], [1, ""], [1, "103"], [2, "NaN"],
    [2, "98"], [3, "103"], [4, "Infinity"], [4, "0"], [5, "-1"],
    [5, null], [6, 59999], [6, "119999"]
  ])("rejects malformed candle field %s=%s", async (index, value) => {
    const row: unknown[] = [...candle];
    row[index as number] = value;
    response([row]);
    await expect(client().getRecentKlines("BTCUSDT", "1m", 240)).rejects.toThrow(/Invalid Binance klines/);
  });

  it("rejects duplicate and reversed history instead of accepting a partial batch", async () => {
    response([candle, candle]);
    await expect(client().getRecentKlines("BTCUSDT", "1m", 240)).rejects.toThrow(/Invalid Binance klines/);
    response([[120000, "100", "102", "99", "101", "2", 179999], candle]);
    await expect(client().getRecentKlines("BTCUSDT", "1m", 240)).rejects.toThrow(/Invalid Binance klines/);
  });

  it("maps valid prices, negative funding, zero interest, and a ratio", async () => {
    response(mark);
    await expect(client().getMarkPrice("BTCUSDT")).resolves.toEqual({
      markPrice: 100, indexPrice: 101, fundingRate: -0.0001, nextFundingTime: 1800000000000
    });
    response({ ...mark, nextFundingTime: 0 });
    await expect(client().getMarkPrice("BTCUSDT")).resolves.toMatchObject({ nextFundingTime: 0 });
    response({ openInterest: "0" });
    await expect(client().getOpenInterest("BTCUSDT")).resolves.toBe(0);
    response([{ longShortRatio: "1.25" }]);
    await expect(client().getTopTraderLongShortRatio("BTCUSDT")).resolves.toBe(1.25);
  });

  it.each([
    { markPrice: "" }, { markPrice: "  " }, { markPrice: "0" }, { markPrice: "-1" },
    { markPrice: "Infinity" }, { markPrice: null }, { markPrice: "secret-invalid-value" },
    { indexPrice: "NaN" }, { indexPrice: undefined }, { lastFundingRate: "" },
    { lastFundingRate: false }, { lastFundingRate: "Infinity" },
    { nextFundingTime: -1 }, { nextFundingTime: 1.5 },
    { nextFundingTime: "1800000000000" }, { nextFundingTime: null }
  ])("rejects malformed mark fields without echoing payloads (%j)", async (fields) => {
    response({ ...mark, ...fields });
    await expect(client().getMarkPrice("BTCUSDT")).rejects.toThrow(/Invalid Binance premiumIndex/);
    await expect(client().getMarkPrice("BTCUSDT")).rejects.not.toThrow("secret-invalid-value");
  });

  it.each([null, [], "secret-invalid-value"])("rejects malformed mark envelopes (%j)", async (value) => {
    response(value);
    await expect(client().getMarkPrice("BTCUSDT")).rejects.toThrow(/Invalid Binance premiumIndex/);
  });

  it.each([null, {}, { openInterest: "" }, { openInterest: "-1" }, { openInterest: "Infinity" }, { openInterest: false }])(
    "rejects malformed open interest (%j)", async (value) => {
      response(value);
      await expect(client().getOpenInterest("BTCUSDT")).rejects.toThrow(/Invalid Binance openInterest/);
    }
  );

  it.each([null, {}, [], [null], [{}], [{ longShortRatio: "" }], [{ longShortRatio: "0" }],
    [{ longShortRatio: "-1" }], [{ longShortRatio: "Infinity" }], [{ longShortRatio: false }]])(
    "rejects absent or malformed ratios instead of fabricating neutral data (%j)", async (value) => {
      response(value);
      await expect(client().getTopTraderLongShortRatio("BTCUSDT")).rejects.toThrow(/Invalid Binance topTraderLongShortRatio/);
    }
  );
});
