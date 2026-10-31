import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHistoricalKlines } from "./backtestKlines.js";

const download = () => fetchHistoricalKlines("https://exchange.invalid", "BTCUSDT", 0, 120_000);
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("historical page deadlines", () => {
  it.each(["headers", "body"])("bounds stalled %s and aborts the request", async (stage) => {
    let signal: AbortSignal | undefined;
    const stuck = new Promise<never>(() => {});
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      signal = init?.signal;
      return stage === "headers" ? stuck : Promise.resolve({ ok: true, status: 200, json: () => stuck });
    }));
    const result = expect(download()).rejects.toThrow(/historical.*BTCUSDT.*startTime=0.*endTime=120000.*10000ms/);
    await vi.advanceTimersByTimeAsync(10_000); await result;
    expect(signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("gives the next page a fresh budget and identifies its cursor on failure", async () => {
    const row = [0, "100", "105", "95", "102", "2", 59_999, "204", 10, "1", "102", "0"];
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify([row])))
      .mockImplementationOnce(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const result = expect(download()).rejects.toThrow(/startTime=60000.*endTime=120000.*10000ms/);
    await vi.advanceTimersByTimeAsync(10_000); await result;
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the timer after success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]")));
    await expect(download()).resolves.toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it("clears the timer after an HTTP error without reading the body", async () => {
    const json = vi.fn(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json }));
    await expect(download()).rejects.toThrow("HTTP 429");
    expect(json).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
