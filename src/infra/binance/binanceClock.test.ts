import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesClient } from "./binanceFuturesClient.js";

const now = 1_800_000_000_000;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const timingError = () => json({ code: -1021, msg: "Timestamp outside receive window" }, 400);
const setup = () => {
  const logger = { warn: vi.fn() };
  const client = new BinanceFuturesClient("https://example.test", "wss://example.test", "test-key", "test-secret", logger as never);
  return { client, logger };
};
const params = (call: any[]) => call[1]?.body instanceof URLSearchParams
  ? new URLSearchParams(call[1].body) : new URL(call[0]).searchParams;
const expectSignature = (call: any[], timestamp: number) => {
  const query = params(call); const signature = query.get("signature"); query.delete("signature");
  expect(query.get("timestamp")).toBe(String(timestamp)); expect(query.get("recvWindow")).toBe("5000");
  expect(signature).toBe(crypto.createHmac("sha256", "test-secret").update(query.toString()).digest("hex"));
};
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("signed Binance request clock", () => {
  it("shares initial synchronization and uses corrected signatures across GET, POST and DELETE", async () => {
    const fetchMock = vi.fn(async (url: string) => url.endsWith("/time")
      ? json({ serverTime: now + 25_000 }) : json([]));
    vi.stubGlobal("fetch", fetchMock); const { client } = setup();
    await Promise.all([client.getBalanceState(), client.createOrder({ symbol: "BTCUSDT", newClientOrderId: "stable" }), client.cancelAllOrders("BTCUSDT")]);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/time"))).toHaveLength(1);
    for (const call of fetchMock.mock.calls.filter(([url]) => !url.endsWith("/time"))) expectSignature(call, now + 25_000);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://example.test/fapi/v1/time");
  });
  it.each(["GET", "POST", "DELETE"])("refreshes and retries one explicitly rejected %s without changing business parameters", async method => {
    let timeCalls = 0; let requests = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/time")) return json({ serverTime: now + (++timeCalls === 1 ? 10_000 : 20_000) });
      return ++requests === 1 ? timingError() : json([]);
    });
    vi.stubGlobal("fetch", fetchMock); const { client } = setup();
    await (method === "GET" ? client.getBalanceState() : method === "POST"
      ? client.createOrder({ symbol: "BTCUSDT", newClientOrderId: "same-order", quantity: 1, side: "BUY" }) : client.cancelAllOrders("BTCUSDT"));
    expect(timeCalls).toBe(2); expect(requests).toBe(2);
    const calls = fetchMock.mock.calls.filter(([url]) => !url.endsWith("/time"));
    expectSignature(calls[0]!, now + 10_000); expectSignature(calls[1]!, now + 20_000);
    const business = (call: any[]) => { const q = params(call); for (const name of ["signature", "timestamp"]) q.delete(name); return q.toString(); };
    expect(business(calls[1]!)).toBe(business(calls[0]!));
  });
  it("coalesces concurrent timestamp failures into a single refresh", async () => {
    let timeCalls = 0; let requests = 0;
    const fetchMock = vi.fn(async (url: string) => url.endsWith("/time")
      ? json({ serverTime: now + ++timeCalls * 10_000 }) : ++requests <= 3 ? timingError() : json([]));
    vi.stubGlobal("fetch", fetchMock); const { client } = setup();
    await Promise.all([client.getBalanceState(), client.createOrder({ newClientOrderId: "stable" }), client.cancelAllOrders("BTCUSDT")]);
    expect(timeCalls).toBe(2); expect(requests).toBe(6);
  });
  it.each(["transport", "timeout", "server", "other-code", "invalid-json", "wrong-status"])("does not replay an ambiguous or non-timing failure: %s", async kind => {
    let requests = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/time")) return json({ serverTime: now });
      requests++;
      if (kind === "transport") throw new Error("network failure");
      if (kind === "timeout") throw new DOMException("timeout", "AbortError");
      if (kind === "invalid-json") return new Response("not json", { status: 400 });
      return json({ code: kind === "other-code" ? -2010 : -1021 }, kind === "server" ? 503 : kind === "wrong-status" ? 429 : 400);
    });
    vi.stubGlobal("fetch", fetchMock); const { client } = setup();
    await expect(client.createOrder({ newClientOrderId: "stable" })).rejects.toThrow(); expect(requests).toBe(1);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/time"))).toHaveLength(1);
  });
  it("surfaces a second timing rejection without looping", async () => {
    const fetchMock = vi.fn(async (url: string) => url.endsWith("/time") ? json({ serverTime: now }) : timingError());
    vi.stubGlobal("fetch", fetchMock); const { client } = setup();
    await expect(client.createOrder({})).rejects.toMatchObject({ status: 400, code: -1021 }); expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it.each([null, {}, { serverTime: "1800000000000" }, { serverTime: Infinity }, { serverTime: -1 }])("fails closed on invalid server time %j before sending signed work", async value => {
    const fetchMock = vi.fn(async () => json(value)); vi.stubGlobal("fetch", fetchMock);
    await expect(setup().client.createOrder({})).rejects.toThrow("clock synchronization failed"); expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("bounds a stalled time body and clears the deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    vi.stubGlobal("fetch", fetchMock); const result = setup().client.createOrder({});
    const rejected = expect(result).rejects.toThrow("clock synchronization failed");
    await vi.advanceTimersByTimeAsync(5_000); await rejected;
    expect(fetchMock).toHaveBeenCalledOnce(); expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects an overly slow clock sample", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 1_001)); return json({ serverTime: now }); }));
    const rejected = expect(setup().client.createOrder({})).rejects.toThrow("clock synchronization failed");
    await vi.advanceTimersByTimeAsync(1_001); await rejected;
  });
  it("refreshes the cached offset after five minutes and permits recovery after sync failure", async () => {
    let times = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!url.endsWith("/time")) return json([]);
      if (++times === 1) throw new Error("private proxy diagnostic");
      return json({ serverTime: Date.now() + 10_000 });
    }));
    const { client, logger } = setup();
    await expect(client.createOrder({})).rejects.toThrow("clock synchronization failed");
    await client.createOrder({}); await client.createOrder({}); expect(times).toBe(2);
    await vi.advanceTimersByTimeAsync(300_000); await client.createOrder({}); expect(times).toBe(3);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private proxy diagnostic");
  });
});
