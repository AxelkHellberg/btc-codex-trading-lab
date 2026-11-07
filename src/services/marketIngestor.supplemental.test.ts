import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { MarketIngestor } from "./marketIngestor.js";

vi.mock("ws", () => ({ default: class extends EventEmitter {
  close() { this.emit("close"); }
  terminate() { this.emit("close"); }
} }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const mark = { markPrice: 100, indexPrice: 100, fundingRate: 0, nextFundingTime: 0 };
const setup = () => {
  const snapshot = { ...mark, lastPrice: 100, openInterest: 1, volume1m: 0 };
  const client = {
    getSymbolFilters: vi.fn(), composeInitialMarketSnapshot: vi.fn().mockResolvedValue(snapshot),
    getRecentKlines: vi.fn().mockResolvedValue([]), getCombinedMarketStreamUrl: () => "wss://example.test",
    getMarkPrice: vi.fn().mockResolvedValue(mark), getOpenInterest: vi.fn().mockResolvedValue(1),
    getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1),
    getBalanceState: vi.fn().mockResolvedValue({ equity: 100 }),
    getPositionState: vi.fn().mockResolvedValue({ side: "flat", quantity: 0 }),
    stopUserStreamKeepalive: vi.fn(), startUserStreamKeepalive: vi.fn(),
    startUserStream: vi.fn().mockResolvedValue("test-key"), connectUserStream: () => Object.assign(new EventEmitter(), { close: vi.fn() })
  };
  const callbacks = { onMarket: vi.fn(), onAccount: vi.fn(), onPosition: vi.fn() };
  const ingestor = new MarketIngestor({ ...config, tradingMode: "live" }, client as never, { warn: vi.fn() } as never, callbacks);
  return { ingestor, client, callbacks };
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps a slow timer refresh single flight across another minute", async () => {
  const x = setup(); await x.ingestor.start();
  const pending = deferred<typeof mark>(); x.client.getMarkPrice.mockReturnValueOnce(pending.promise);
  x.callbacks.onMarket.mockClear();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(x.client.getMarkPrice).toHaveBeenCalledTimes(2); // startup and one timer poll
  pending.resolve(mark); await vi.advanceTimersByTimeAsync(0);
  expect(x.callbacks.onMarket).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(x.client.getMarkPrice).toHaveBeenCalledTimes(3);
  await x.ingestor.stop();
});
it("discards late results without changing retained state after stop", async () => {
  const x = setup(); await x.ingestor.start();
  const pending = deferred<typeof mark>(); x.client.getMarkPrice.mockReturnValueOnce(pending.promise);
  const before = x.ingestor["snapshot"];
  const refresh = x.ingestor["refreshSupplemental"]();
  await x.ingestor.stop(); vi.clearAllMocks();
  pending.resolve({ ...mark, markPrice: 999 }); await refresh;
  expect(x.ingestor["snapshot"]).toBe(before);
  expect(x.callbacks.onMarket).not.toHaveBeenCalled();
  expect(x.callbacks.onAccount).not.toHaveBeenCalled();
  expect(x.callbacks.onPosition).not.toHaveBeenCalled();
});
it.each(["onMarket", "onAccount"] as const)("admits no further callbacks if stop occurs during %s", async (sink) => {
  const x = setup(); await x.ingestor.start();
  const pending = deferred<void>(); x.callbacks[sink].mockReturnValueOnce(pending.promise);
  vi.clearAllMocks();
  const refresh = x.ingestor["refreshSupplemental"]();
  await vi.advanceTimersByTimeAsync(0);
  expect(x.callbacks[sink]).toHaveBeenCalledOnce();
  await x.ingestor.stop(); pending.resolve(); await refresh;
  expect(x.callbacks.onPosition).not.toHaveBeenCalled();
  if (sink === "onMarket") expect(x.callbacks.onAccount).not.toHaveBeenCalled();
});
it("waits for old network work on restart and discards the old generation", async () => {
  const x = setup(); await x.ingestor.start();
  const pending = deferred<typeof mark>(); x.client.getMarkPrice.mockReturnValueOnce(pending.promise);
  const refresh = x.ingestor["refreshSupplemental"]();
  await x.ingestor.stop(); vi.clearAllMocks();
  const restarting = x.ingestor.start(); await vi.advanceTimersByTimeAsync(0);
  expect(x.client.getSymbolFilters).not.toHaveBeenCalled();
  pending.resolve({ ...mark, markPrice: 999 }); await refresh; await restarting;
  expect(x.callbacks.onMarket.mock.calls.every(([snapshot]) => snapshot.markPrice !== 999)).toBe(true);
  expect(x.client.getMarkPrice).toHaveBeenCalledOnce();
  await x.ingestor.stop();
});
it("does not install a timer or sockets when stop interrupts startup", async () => {
  const x = setup(); const pending = deferred<typeof mark>();
  x.client.composeInitialMarketSnapshot.mockReturnValueOnce(pending.promise);
  const starting = x.ingestor.start(); await vi.advanceTimersByTimeAsync(0);
  await x.ingestor.stop(); pending.resolve(mark); await starting;
  expect(x.callbacks.onMarket).not.toHaveBeenCalled();
  expect(x.client.getMarkPrice).not.toHaveBeenCalled();
  expect(x.client.startUserStream).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("releases the in-flight slot after a failed refresh", async () => {
  const x = setup(); await x.ingestor.start();
  x.client.getMarkPrice.mockRejectedValueOnce(new Error("offline failure"));
  await vi.advanceTimersByTimeAsync(120_000);
  expect(x.client.getMarkPrice).toHaveBeenCalledTimes(3);
  await x.ingestor.stop();
});

it("keeps ownership of sibling requests after one request rejects early", async () => {
  const x = setup(); await x.ingestor.start();
  const pending = deferred<number>();
  x.client.getMarkPrice.mockRejectedValueOnce(new Error("early failure"));
  x.client.getOpenInterest.mockReturnValueOnce(pending.promise);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(x.client.getMarkPrice).toHaveBeenCalledTimes(2);
  pending.resolve(2); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(x.client.getMarkPrice).toHaveBeenCalledTimes(3);
  await x.ingestor.stop();
});
