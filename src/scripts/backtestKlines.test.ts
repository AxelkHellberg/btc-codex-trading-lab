import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchHistoricalKlines } from "./backtestKlines.js";

const start = 1_700_000_000_000;
const kline = (openTime = start): unknown[] => [
  openTime, "100", "105", "95", "102", "2", openTime + 59_999, "204", 10, "1", "102", "0"
];
const jsonResponse = (payload: unknown): Response => new Response(JSON.stringify(payload), { status: 200 });
const download = (endTime = start + 60_000) =>
  fetchHistoricalKlines("https://example.test", "BTCUSDT", start, endTime);

afterEach(() => vi.unstubAllGlobals());

describe("historical Binance klines", () => {
  it("rejects HTTP errors with endpoint/status context without reading the body", async () => {
    const response = { ok: false, status: 429, json: vi.fn(), text: vi.fn() };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(download()).rejects.toThrow("/fapi/v1/klines (HTTP 429): request failed");
    expect(response.json).not.toHaveBeenCalled();
    expect(response.text).not.toHaveBeenCalled();
  });

  it("gives endpoint context for a failed network request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("untrusted remote diagnostic")));

    await expect(download()).rejects.toThrow(
      "Binance historical klines request to /fapi/v1/klines failed before an HTTP response"
    );
  });

  it("rejects invalid JSON without including response text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private proxy details", { status: 200 })));

    await expect(download()).rejects.toThrow("/fapi/v1/klines (HTTP 200): invalid JSON");
  });

  it.each([null, { code: -1003, msg: "rate limit" }, "not an array"])(
    "rejects a non-array successful response: %j",
    async (payload) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));
      await expect(download()).rejects.toThrow("/fapi/v1/klines (HTTP 200): expected a kline array");
    }
  );

  it.each([
    [[], "complete kline tuple"],
    [{}, "complete kline tuple"],
    [kline().slice(0, 7), "complete kline tuple"],
    [["bad timestamp", ...kline().slice(1)], "openTime"],
    [[...kline().slice(0, 6), null, ...kline().slice(7)], "closeTime"],
    [[start, "", ...kline().slice(2)], "open"],
    [[start, "NaN", ...kline().slice(2)], "open"],
    [[start, "100", "Infinity", ...kline().slice(3)], "high"],
    [[...kline().slice(0, 5), "-1", ...kline().slice(6)], "volume"],
    [[start, "100", "99", ...kline().slice(3)], "inconsistent OHLC"],
    [[...kline().slice(0, 6), start - 1, ...kline().slice(7)], "precedes openTime"]
  ])("rejects malformed rows before returning candles: %j", async (row, reason) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([row])));

    await expect(download()).rejects.toThrow(new RegExp(`invalid row 1.*${reason}`));
  });

  it("maps a valid page and preserves legitimate zero volume", async () => {
    const row = kline();
    row[5] = "0";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([row])));

    await expect(download()).resolves.toEqual([
      { openTime: start, open: 100, high: 105, low: 95, close: 102, volume: 0, closeTime: start + 59_999 }
    ]);
  });

  it("treats an empty page as a graceful terminal page", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([kline()])).mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(download(start + 120_000)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![0]).toContain(`startTime=${start + 60_000}`);
  });

  it("does not return an earlier valid page if a later page is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(jsonResponse([kline()])).mockResolvedValueOnce(jsonResponse({ error: "broken" }))
    );

    await expect(download(start + 120_000)).rejects.toThrow("expected a kline array");
  });

  it("rejects a page that cannot advance pagination", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([kline(start - 60_000)])));

    await expect(download()).rejects.toThrow("page did not advance the historical cursor");
  });
});
