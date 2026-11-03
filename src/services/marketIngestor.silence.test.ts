import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import { MarketIngestor } from "./marketIngestor.js";

const sockets = vi.hoisted(() => [] as any[]);
vi.mock("ws", () => ({ default: class extends EventEmitter {
  close = vi.fn(() => this.emit("close"));
  terminate = vi.fn(() => this.emit("close"));
  constructor() { super(); sockets.push(this); }
} }));

const setup = async () => {
  const snapshot = { markPrice: 100, lastPrice: 100, openInterest: 1, volume1m: 0 } as MarketSnapshot;
  const client = {
    getSymbolFilters: vi.fn(), composeInitialMarketSnapshot: vi.fn().mockResolvedValue(snapshot),
    getRecentKlines: vi.fn().mockResolvedValue([]), getCombinedMarketStreamUrl: () => "wss://example.test",
    getMarkPrice: vi.fn().mockResolvedValue({ markPrice: 100, indexPrice: 100 }),
    getOpenInterest: vi.fn().mockResolvedValue(1), getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1),
    stopUserStreamKeepalive: vi.fn()
  };
  const callbacks = { onMarket: vi.fn(), onAccount: vi.fn(), onPosition: vi.fn() };
  const logger = { warn: vi.fn() };
  const ingestor = new MarketIngestor({ ...config, tradingMode: "paper" }, client as never, logger as never, callbacks);
  await ingestor.start();
  return { ingestor, client, callbacks, logger };
};
const frame = () => JSON.stringify({ data: { e: "bookTicker", b: "99", a: "101", E: Date.now() } });
beforeEach(() => { vi.useFakeTimers(); sockets.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("market stream silence recovery", () => {
  it("retires a silent socket despite successful REST refreshes and resumes frames", async () => {
    const x = await setup();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(x.client.getMarkPrice.mock.calls.length).toBeGreaterThan(1);
    expect(sockets).toHaveLength(2);
    expect(sockets[0].terminate).toHaveBeenCalledOnce();
    const before = x.callbacks.onMarket.mock.calls.length;
    sockets[1].emit("message", frame()); await vi.advanceTimersByTimeAsync(0);
    expect(x.callbacks.onMarket).toHaveBeenCalledTimes(before + 1);
    await x.ingestor.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("healthy stream traffic resets the thirty-second deadline", async () => {
    const x = await setup();
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(20_000); sockets[0].emit("message", frame());
    }
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_999); expect(sockets[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(sockets[0].terminate).toHaveBeenCalledOnce();
    await x.ingestor.stop();
  });
  it("coalesces close/error/timeout and ignores all retired socket events", async () => {
    const x = await setup(); const old = sockets[0];
    await vi.advanceTimersByTimeAsync(30_000); old.emit("close"); old.emit("error", new Error("private diagnostic"));
    await vi.advanceTimersByTimeAsync(3_000); expect(sockets).toHaveLength(2);
    const before = x.callbacks.onMarket.mock.calls.length;
    old.emit("message", frame()); old.emit("close");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sockets).toHaveLength(2); expect(x.callbacks.onMarket).toHaveBeenCalledTimes(before);
    sockets[1].emit("message", frame()); await vi.advanceTimersByTimeAsync(0);
    expect(x.callbacks.onMarket).toHaveBeenCalledTimes(before + 1);
    expect(JSON.stringify(x.logger.warn.mock.calls)).not.toContain("private diagnostic");
    await x.ingestor.stop();
  });
  it("cancels both watchdog and queued replacement during shutdown and supports restart", async () => {
    const x = await setup(); await vi.advanceTimersByTimeAsync(30_000);
    await x.ingestor.stop(); await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
    await x.ingestor.start(); expect(sockets).toHaveLength(2);
    sockets[0].emit("close"); await vi.advanceTimersByTimeAsync(3_000); expect(sockets).toHaveLength(2);
    await x.ingestor.stop(); expect(vi.getTimerCount()).toBe(0);
  });
  it("caps unsuccessful replacement delays and resets backoff only after stream activity", async () => {
    const x = await setup();
    for (const delay of [3_000, 6_000, 12_000, 24_000, 30_000, 30_000]) {
      const old = sockets.at(-1); old.emit("close");
      const count = sockets.length;
      await vi.advanceTimersByTimeAsync(delay - 1); expect(sockets).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1); expect(sockets).toHaveLength(count + 1);
    }
    sockets.at(-1).emit("message", frame()); sockets.at(-1).emit("close");
    const count = sockets.length; await vi.advanceTimersByTimeAsync(3_000); expect(sockets).toHaveLength(count + 1);
    await x.ingestor.stop();
  });
});
