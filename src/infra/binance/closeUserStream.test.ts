import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesClient } from "./binanceFuturesClient.js";
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const client = () => new BinanceFuturesClient("https://offline.invalid", "wss://offline.invalid", "test-key", "unused-secret", {} as Logger);
describe("close user stream protocol", () => {
  it("accepts a successful empty DELETE response using only API-key auth", async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", request);
    await client().closeUserStream();
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://offline.invalid/fapi/v1/listenKey");
    expect(init.method).toBe("DELETE");
    expect(init.headers).toEqual({ "X-MBX-APIKEY": "test-key" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
  });
  it("rejects non-success status without exposing response content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private-payload", { status: 503 })));
    await expect(client().closeUserStream()).rejects.toThrow("User stream close failed (HTTP 503)");
  });
  it("bounds key creation so shutdown can drain a stalled request", async () => {
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("request aborted")));
    })));
    const request = client().startUserStream();
    const rejected = expect(request).rejects.toThrow("request aborted");
    await rejected;
  }, 15_000);

});
