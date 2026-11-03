import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { MarketIngestor } from "./marketIngestor.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const setup = () => {
  const sockets: (EventEmitter & { close: ReturnType<typeof vi.fn> })[] = [];
  const messages: ((event: unknown) => void)[] = [];
  const keepaliveFailures: (() => void)[] = [];
  const client = {
    startUserStream: vi.fn().mockResolvedValue("private-key"),
    startUserStreamKeepalive: vi.fn((_key: string, failure: () => void) => keepaliveFailures.push(failure)),
    stopUserStreamKeepalive: vi.fn(),
    connectUserStream: vi.fn((_key: string, callback: (event: unknown) => void) => {
      const socket = Object.assign(new EventEmitter(), { close: vi.fn() });
      socket.close.mockImplementation(() => socket.emit("close"));
      sockets.push(socket); messages.push(callback); return socket;
    }),
    getBalanceState: vi.fn().mockResolvedValue({ equity: 101 }),
    getPositionState: vi.fn().mockResolvedValue({ side: "flat" })
  };
  const logger = { warn: vi.fn() };
  const callbacks = { onMarket: vi.fn(), onAccount: vi.fn(), onPosition: vi.fn() };
  const ingestor = new MarketIngestor({ symbol: "BTCUSDT", tradingMode: "live" } as AppConfig,
    client as unknown as BinanceFuturesClient, logger as unknown as Logger, callbacks);
  const start = () => (ingestor as unknown as { startUserStream: () => Promise<void> }).startUserStream();
  return { ingestor, start, client, callbacks, logger, sockets, messages, keepaliveFailures };
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("user-stream recovery", () => {
  it("replaces an expired key without close, and resumes account events", async () => {
    const x = setup(); await x.start();
    x.messages[0]!({ e: "listenKeyExpired" });
    expect(x.sockets[0]!.close).toHaveBeenCalledOnce();
    expect(x.client.stopUserStreamKeepalive).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(x.client.startUserStream).toHaveBeenCalledTimes(2);
    x.messages[1]!({ e: "ACCOUNT_UPDATE" }); await vi.advanceTimersByTimeAsync(0);
    expect(x.callbacks.onAccount).toHaveBeenCalledOnce();
    expect(x.callbacks.onPosition).toHaveBeenCalledOnce();
    await x.ingestor.stop();
  });
  it("coalesces expiry, close and keepalive failures, ignoring obsolete callbacks", async () => {
    const x = setup(); await x.start();
    x.messages[0]!({ e: "listenKeyExpired" }); x.sockets[0]!.emit("close"); x.keepaliveFailures[0]!();
    await vi.advanceTimersByTimeAsync(3_000);
    x.messages[0]!({ e: "ACCOUNT_UPDATE" }); x.messages[0]!({ e: "listenKeyExpired" });
    x.sockets[0]!.emit("close"); x.keepaliveFailures[0]!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(x.client.startUserStream).toHaveBeenCalledTimes(2);
    expect(x.callbacks.onAccount).not.toHaveBeenCalled();
    await x.ingestor.stop();
  });
  it("observes failed recovery and retries once the capped backoff permits it", async () => {
    const x = setup(); await x.start();
    x.client.startUserStream.mockRejectedValueOnce(new Error("secret-key-url"));
    x.sockets[0]!.emit("close"); await vi.advanceTimersByTimeAsync(3_000);
    expect(x.client.startUserStream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_999); expect(x.client.startUserStream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(x.client.startUserStream).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(x.logger.warn.mock.calls)).not.toContain("secret-key-url");
    await x.ingestor.stop();
  });
  it("caps repeated failure delays at thirty seconds", async () => {
    const x = setup(); await x.start(); x.client.startUserStream.mockRejectedValue(new Error("offline"));
    x.sockets[0]!.emit("close");
    for (const delay of [3_000, 6_000, 12_000, 24_000, 30_000, 30_000]) await vi.advanceTimersByTimeAsync(delay);
    expect(x.client.startUserStream).toHaveBeenCalledTimes(7);
    await x.ingestor.stop(); await vi.advanceTimersByTimeAsync(60_000);
    expect(x.client.startUserStream).toHaveBeenCalledTimes(7);
  });
  it("cancels a pending recovery on stop", async () => {
    const x = setup(); await x.start(); x.messages[0]!({ e: "listenKeyExpired" });
    await x.ingestor.stop(); await vi.advanceTimersByTimeAsync(60_000);
    expect(x.client.startUserStream).toHaveBeenCalledOnce();
  });
  it("does not open a late connection or keepalive after stopping during the key request", async () => {
    const x = setup(); await x.start(); const key = deferred<string>();
    x.client.startUserStream.mockReturnValueOnce(key.promise); x.sockets[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(3_000); await x.ingestor.stop(); key.resolve("late-private-key");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(x.client.connectUserStream).toHaveBeenCalledOnce();
    expect(x.client.startUserStreamKeepalive).toHaveBeenCalledOnce();
  });
  it("does not retry a late key rejection after shutdown", async () => {
    const x = setup(); await x.start(); const key = deferred<string>();
    x.client.startUserStream.mockReturnValueOnce(key.promise); x.sockets[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(3_000); await x.ingestor.stop(); key.reject(new Error("late failure"));
    await vi.advanceTimersByTimeAsync(60_000); expect(x.client.startUserStream).toHaveBeenCalledTimes(2);
  });
  it("recovers an active keepalive failure and observes callback failures", async () => {
    const x = setup(); await x.start(); x.keepaliveFailures[0]!(); await vi.advanceTimersByTimeAsync(3_000);
    expect(x.client.connectUserStream).toHaveBeenCalledTimes(2);
    x.callbacks.onAccount.mockRejectedValueOnce(new Error("secret-account"));
    x.messages[1]!({ e: "ORDER_TRADE_UPDATE" }); await vi.advanceTimersByTimeAsync(0);
    expect(x.logger.warn).toHaveBeenCalledWith("Failed to process user stream event");
    expect(JSON.stringify(x.logger.warn.mock.calls)).not.toContain("secret-account");
    await x.ingestor.stop();
  });
});
