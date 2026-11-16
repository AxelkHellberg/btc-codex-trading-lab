import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { MarketIngestor } from "./marketIngestor.js";

const sockets = vi.hoisted(() => [] as EventEmitter[]);
vi.mock("ws", () => ({ default: class extends EventEmitter {
  constructor() { super(); sockets.push(this); }
  close() { this.emit("close"); }
  terminate() { this.emit("close"); }
} }));
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const mark = { markPrice: 100, indexPrice: 100, fundingRate: 0, nextFundingTime: 0 };
const snapshot = { ...mark, lastPrice: 100, openInterest: 1, volume1m: 0 };
const setup = () => {
  const client = {
    getSymbolFilters: vi.fn().mockResolvedValue({}), composeInitialMarketSnapshot: vi.fn().mockResolvedValue(snapshot),
    getRecentKlines: vi.fn().mockResolvedValue([]), getCombinedMarketStreamUrl: () => "wss://example.test",
    getMarkPrice: vi.fn().mockResolvedValue(mark), getOpenInterest: vi.fn().mockResolvedValue(1),
    getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1),
    getBalanceState: vi.fn().mockResolvedValue({ equity: 100 }),
    getPositionState: vi.fn().mockResolvedValue({ side: "flat", quantity: 0 }),
    stopUserStreamKeepalive: vi.fn(), startUserStreamKeepalive: vi.fn(),
    startUserStream: vi.fn().mockResolvedValue("test-key"),
    connectUserStream: vi.fn(() => {
      const socket = new EventEmitter();
      return Object.assign(socket, { close: () => socket.emit("close") });
    })
  };
  const callbacks = { onMarket: vi.fn(), onAccount: vi.fn(), onPosition: vi.fn() };
  const ingestor = new MarketIngestor({ ...config, tradingMode: "live" }, client as never, { warn: vi.fn() } as never, callbacks);
  return { ingestor, client, callbacks };
};
const instances: MarketIngestor[] = [];
const create = () => { const x = setup(); instances.push(x.ingestor); return x; };
beforeEach(() => { vi.useFakeTimers(); sockets.length = 0; });
afterEach(async () => {
  for (const ingestor of instances.splice(0)) await ingestor.stop();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

it("keeps repeated completed starts on one bootstrap, stream and timer set", async () => {
  const x = create();
  await x.ingestor.start(); await x.ingestor.start();
  expect(x.client.getSymbolFilters).toHaveBeenCalledOnce();
  expect(x.client.startUserStream).toHaveBeenCalledOnce();
  expect(sockets).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(2);
  await x.ingestor.stop();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(x.client.getMarkPrice).toHaveBeenCalledOnce();
});
it("makes concurrent callers await the same completed startup", async () => {
  const x = create(); const pending = deferred<typeof snapshot>();
  x.client.composeInitialMarketSnapshot.mockReturnValueOnce(pending.promise);
  let firstReady = false, secondReady = false;
  const first = x.ingestor.start().then(() => { firstReady = true; });
  const second = x.ingestor.start().then(() => { secondReady = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(x.client.getSymbolFilters).toHaveBeenCalledOnce();
  expect(x.client.composeInitialMarketSnapshot).toHaveBeenCalledOnce();
  expect(firstReady).toBe(false); expect(secondReady).toBe(false);
  pending.resolve(snapshot); await Promise.all([first, second]);
  expect(firstReady).toBe(true); expect(secondReady).toBe(true);
  expect(x.client.startUserStream).toHaveBeenCalledOnce();
  expect(sockets).toHaveLength(1);
});
it("releases a failed bootstrap so a later call can retry", async () => {
  const x = create(); x.client.getSymbolFilters.mockRejectedValueOnce(new Error("bootstrap unavailable"));
  await expect(x.ingestor.start()).rejects.toThrow("bootstrap unavailable");
  expect(vi.getTimerCount()).toBe(0);
  await x.ingestor.start();
  expect(x.client.getSymbolFilters).toHaveBeenCalledTimes(2);
  expect(sockets).toHaveLength(1);
  expect(x.client.startUserStream).toHaveBeenCalledOnce();
});
it("retires installed resources when the final startup step fails", async () => {
  const x = create(); x.client.startUserStream.mockRejectedValueOnce(new Error("stream unavailable"));
  await expect(x.ingestor.start()).rejects.toThrow("stream unavailable");
  expect(vi.getTimerCount()).toBe(0);
  await x.ingestor.start();
  expect(sockets).toHaveLength(2);
  expect(x.client.startUserStream).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(2);
  await x.ingestor.stop(); expect(vi.getTimerCount()).toBe(0);
});
it("drains interrupted bootstrap before starting a new session", async () => {
  const x = create(); const pending = deferred<typeof snapshot>();
  x.client.composeInitialMarketSnapshot.mockReturnValueOnce(pending.promise);
  const first = x.ingestor.start(); await vi.advanceTimersByTimeAsync(0);
  await x.ingestor.stop();
  const restart = x.ingestor.start(); await vi.advanceTimersByTimeAsync(0);
  expect(x.client.getSymbolFilters).toHaveBeenCalledOnce();
  pending.resolve({ ...snapshot, markPrice: 999 }); await Promise.all([first, restart]);
  expect(x.client.getSymbolFilters).toHaveBeenCalledTimes(2);
  expect(x.callbacks.onMarket.mock.calls.every(([value]) => value.markPrice !== 999)).toBe(true);
  expect(x.client.startUserStream).toHaveBeenCalledOnce();
  expect(sockets).toHaveLength(1);
  await x.ingestor.start(); expect(x.client.getSymbolFilters).toHaveBeenCalledTimes(2);
});
it("does not let a retired startup failure stop its queued replacement", async () => {
  const x = create(); const pending = deferred<object>();
  x.client.getSymbolFilters.mockReturnValueOnce(pending.promise);
  const first = x.ingestor.start(); const failed = expect(first).rejects.toThrow("retired failure");
  await vi.advanceTimersByTimeAsync(0); await x.ingestor.stop();
  const replacement = deferred<typeof snapshot>();
  x.client.composeInitialMarketSnapshot.mockReturnValueOnce(replacement.promise);
  let restartReady = false, repeatedReady = false;
  const restart = x.ingestor.start().then(() => { restartReady = true; });
  const repeated = x.ingestor.start().then(() => { repeatedReady = true; });
  await vi.advanceTimersByTimeAsync(0);
  pending.reject(new Error("retired failure")); await failed;
  await vi.advanceTimersByTimeAsync(0);
  expect(x.client.getSymbolFilters).toHaveBeenCalledTimes(2);
  expect(restartReady).toBe(false); expect(repeatedReady).toBe(false);
  replacement.resolve(snapshot); await Promise.all([restart, repeated]);
  expect(restartReady).toBe(true); expect(repeatedReady).toBe(true);
  expect(x.client.startUserStream).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(2);
});
