import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesClient } from "./binanceFuturesClient.js";

afterEach(() => vi.unstubAllGlobals());
describe("Binance position-mode protocol", () => {
  it.each([true, false])("reads the signed mode endpoint (%s)", async (dualSidePosition) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ dualSidePosition })));
    vi.stubGlobal("fetch", fetch);
    const client = new BinanceFuturesClient("https://unused.invalid", "wss://unused.invalid", "test-key", "test-secret", {} as Logger);
    await expect(client.getPositionMode()).resolves.toBe(dualSidePosition);
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.pathname).toBe("/fapi/v1/positionSide/dual");
    expect(url.searchParams.has("timestamp")).toBe(true);
    expect(url.searchParams.has("signature")).toBe(true);
    expect(fetch.mock.calls).toHaveLength(1);
  });
  it.each([null, {}, { dualSidePosition: "false" }, { dualSidePosition: 0 }, []])("rejects malformed mode responses (%j)", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(response))));
    const client = new BinanceFuturesClient("https://unused.invalid", "wss://unused.invalid", "key", "secret", {} as Logger);
    await expect(client.getPositionMode()).rejects.toThrow(/boolean dualSidePosition/);
  });
  it("propagates an HTTP failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    const client = new BinanceFuturesClient("https://unused.invalid", "wss://unused.invalid", "key", "secret", {} as Logger);
    await expect(client.getPositionMode()).rejects.toThrow();
  });
});
