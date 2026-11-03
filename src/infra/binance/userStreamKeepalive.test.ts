import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesClient } from "./binanceFuturesClient.js";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe("user-stream keepalive failure signal", () => {
  it("notifies recovery on a failed keepalive without logging request contents", async () => {
    vi.useFakeTimers(); const logger = { warn: vi.fn() };
    const client = new BinanceFuturesClient("https://offline.invalid", "wss://offline.invalid", "", "", logger as unknown as Logger);
    const request = vi.spyOn(client as unknown as { unsignedPrivatePut: () => Promise<unknown> }, "unsignedPrivatePut")
      .mockRejectedValue(new Error("private-listen-key"));
    const failure = vi.fn(); client.startUserStreamKeepalive("private-listen-key", failure);
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(request).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private-listen-key");
    client.stopUserStreamKeepalive(); await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(request).toHaveBeenCalledOnce();
  });
  it("leaves a successful keepalive alone", async () => {
    vi.useFakeTimers(); const logger = { warn: vi.fn() };
    const client = new BinanceFuturesClient("https://offline.invalid", "wss://offline.invalid", "", "", logger as unknown as Logger);
    vi.spyOn(client as unknown as { unsignedPrivatePut: () => Promise<unknown> }, "unsignedPrivatePut").mockResolvedValue({});
    const failure = vi.fn(); client.startUserStreamKeepalive("key", failure);
    await vi.advanceTimersByTimeAsync(50 * 60_000); expect(failure).not.toHaveBeenCalled();
    client.stopUserStreamKeepalive();
  });
});
