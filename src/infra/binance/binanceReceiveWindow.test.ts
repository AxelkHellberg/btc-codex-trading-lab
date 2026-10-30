import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesClient } from "./binanceFuturesClient.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules(); });

describe("signed receive window", () => {
  it.each([undefined, 12000])("signs configured receive window %s for GET, POST and DELETE", async (window) => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify([{ asset: "USDT", balance: "1000", availableBalance: "1000", crossWalletBalance: "1000", crossUnPnl: "0", updateTime: 1_800_000_000_000 }]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
    const client = new BinanceFuturesClient("https://example.test", "wss://example.test/stream", "test-key", "test-secret", { warn: vi.fn() } as never, window);
    await client.getBalanceState();
    await client.changeLeverage("BTCUSDT", 2);
    await client.createOrder({ symbol: "BTCUSDT", side: "BUY", recvWindow: 1, timestamp: 1, signature: "wrong" });
    await client.cancelAllOrders("BTCUSDT");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetchMock.mock.calls) {
      const params = init?.body instanceof URLSearchParams ? new URLSearchParams(init.body) : new URL(url).searchParams;
      const signature = params.get("signature"); params.delete("signature");
      expect(params.get("recvWindow")).toBe(String(window ?? 5000));
      expect(params.get("timestamp")).toBe("1800000000000");
      expect(signature).toBe(crypto.createHmac("sha256", "test-secret").update(params.toString()).digest("hex"));
      expect(init.headers["X-MBX-APIKEY"]).toBe("test-key");
    }
  });
  it.each([0, -1, 1.5, 60001, Infinity, NaN])("rejects invalid direct client window %s before a request", (window) => {
    expect(() => new BinanceFuturesClient("https://example.test", "wss://example.test", "", "", {} as never, window)).toThrow("receive window");
  });
  it("leaves public and unsigned listen-key requests unsigned", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"listenKey":"key"}'));
    vi.stubGlobal("fetch", fetchMock);
    const client = new BinanceFuturesClient("https://example.test", "wss://example.test", "key", "secret", {} as never, 12000);
    await client.startUserStream();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.test/fapi/v1/listenKey");
    expect(init.body).toBeUndefined();
    fetchMock.mockResolvedValueOnce(new Response('{"markPrice":"100","indexPrice":"100","lastFundingRate":"0","nextFundingTime":1000}'));
    await client.getMarkPrice("BTCUSDT");
    const publicUrl = new URL(fetchMock.mock.calls[1]![0]);
    expect(publicUrl.searchParams.get("symbol")).toBe("BTCUSDT");
    expect(publicUrl.searchParams.has("recvWindow")).toBe(false);
    expect(publicUrl.searchParams.has("signature")).toBe(false);
  });
  it.each(["0", "-2", "1.5", "60001", "Infinity", "invalid", ""]) ("rejects invalid environment window %s", async (value) => {
    vi.stubEnv("BINANCE_RECV_WINDOW_MS", value);
    await expect(import("../../config.js")).rejects.toThrow();
  });
  it("loads the configured window", async () => {
    vi.stubEnv("BINANCE_RECV_WINDOW_MS", "12000");
    expect((await import("../../config.js")).config.binance.recvWindowMs).toBe(12000);
  });
});
