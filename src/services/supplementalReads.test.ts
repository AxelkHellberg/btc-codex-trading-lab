import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import type { AccountState, MarketSnapshot, PositionState } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { MarketIngestor } from "./marketIngestor.js";

const market: MarketSnapshot = {
  symbol: "BTCUSDT", markPrice: 100, indexPrice: 100, lastPrice: 100,
  bestBid: 99, bestAsk: 101, spreadBps: 200, fundingRate: 0,
  nextFundingTime: 1800000000000, openInterest: 10, openInterestChangePct1m: 0,
  topTraderLongShortRatio: 1, volume1m: 0, priceChangePct1m: 0, priceChangePct5m: 0,
  priceChangePct15m: 0, priceChangePct1h: 0, intradayHigh: 100, intradayLow: 100,
  distanceFromIntradayHighPct: 0, distanceFromIntradayLowPct: 0, emaFast: 100,
  emaMedium: 100, trendStrengthPct: 0, volumeAcceleration: 1, timestamp: 1
};
const account: AccountState = {
  equity: 100, walletBalance: 100, availableBalance: 50, dailyPnl: 0,
  weeklyDrawdown: 0, consecutiveLosses: 0, openOrders: 0, updatedAt: 2
};
const position: PositionState = {
  side: "long", quantity: 1, entryPrice: 100, markPrice: 101, leverage: 2,
  unrealizedPnl: 1, realizedPnl: 0
};

const fixture = (mode = "live") => {
  const callbacks = { onMarket: vi.fn(), onAccount: vi.fn(), onPosition: vi.fn() };
  const client = {
    getMarkPrice: vi.fn().mockResolvedValue({ markPrice: 101, indexPrice: 100, fundingRate: 0, nextFundingTime: 1800000000000 }),
    getOpenInterest: vi.fn().mockResolvedValue(11),
    getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1.2),
    getBalanceState: vi.fn().mockResolvedValue(account),
    getPositionState: vi.fn().mockResolvedValue(position),
    stopUserStreamKeepalive: vi.fn()
  };
  const logger = { warn: vi.fn() };
  const ingestor = new MarketIngestor(
    { symbol: "BTCUSDT", tradingMode: mode } as AppConfig,
    client as unknown as BinanceFuturesClient, logger as unknown as Logger, callbacks
  );
  const internal = ingestor as unknown as { snapshot: MarketSnapshot; refreshSupplemental(): Promise<void>; stopped: boolean };
  internal.snapshot = { ...market };
  return { callbacks, client, logger, internal, ingestor };
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
describe("independent supplemental upstream reads", () => {
  it.each(["getBalanceState", "getPositionState"] as const)("publishes market data when %s rejects", async (method) => {
    const {client, internal, callbacks, logger} = fixture();
    client[method].mockRejectedValue(new Error("secret signed URL"));
    await internal.refreshSupplemental();
    expect(callbacks.onMarket).toHaveBeenCalledOnce();
    expect(callbacks[method === "getBalanceState" ? "onPosition" : "onAccount"]).toHaveBeenCalledOnce();
    expect(callbacks[method === "getBalanceState" ? "onAccount" : "onPosition"]).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret signed URL");
  });
  it.each(["getMarkPrice", "getOpenInterest", "getTopTraderLongShortRatio"] as const)("retains the market snapshot but delivers private state when %s rejects", async (method) => {
    const {client, internal, callbacks} = fixture();
    client[method].mockRejectedValue(new Error("failed")); const before = internal.snapshot;
    await internal.refreshSupplemental(); expect(internal.snapshot).toBe(before);
    expect(callbacks.onMarket).not.toHaveBeenCalled();
    expect(callbacks.onAccount).toHaveBeenCalledExactlyOnceWith(account);
    expect(callbacks.onPosition).toHaveBeenCalledExactlyOnceWith(position);
  });
  it("delivers market and position while balance is still pending", async () => {
    const {client, internal, callbacks} = fixture(); const slow = deferred<AccountState>();
    client.getBalanceState.mockReturnValue(slow.promise); const pending = internal.refreshSupplemental();
    await vi.waitFor(() => expect(callbacks.onMarket).toHaveBeenCalledOnce());
    expect(callbacks.onPosition).toHaveBeenCalledOnce(); expect(callbacks.onAccount).not.toHaveBeenCalled();
    slow.resolve(account); await pending; expect(callbacks.onAccount).toHaveBeenCalledOnce();
  });
  it("delivers private results while public data is still pending", async () => {
    const {client, internal, callbacks} = fixture(); const slow = deferred<number>();
    client.getOpenInterest.mockReturnValue(slow.promise); const pending = internal.refreshSupplemental();
    await vi.waitFor(() => expect(callbacks.onPosition).toHaveBeenCalledOnce());
    expect(callbacks.onAccount).toHaveBeenCalledOnce(); expect(callbacks.onMarket).not.toHaveBeenCalled();
    slow.resolve(11); await pending; expect(callbacks.onMarket).toHaveBeenCalledOnce();
  });
  it("does not overlap supplemental refresh batches", async () => {
    const {client, internal} = fixture();const slow = deferred<number>();
    client.getOpenInterest.mockReturnValue(slow.promise);
    const first = internal.refreshSupplemental(); const second = internal.refreshSupplemental();
    await vi.waitFor(() => expect(client.getOpenInterest).toHaveBeenCalledOnce());
    slow.resolve(11); await Promise.all([first,second]);
    expect(client.getBalanceState).toHaveBeenCalledOnce();
  });
  it("ignores reads that finish after stop", async () => {
    const {client, internal, callbacks, ingestor} = fixture(); const slow=deferred<number>();
    client.getOpenInterest.mockReturnValue(slow.promise);
    const balance = deferred<AccountState>();client.getBalanceState.mockReturnValue(balance.promise);
    const pos=deferred<PositionState>(); client.getPositionState.mockReturnValue(pos.promise);
    const before=internal.snapshot;const pending=internal.refreshSupplemental();
    await vi.waitFor(()=>expect(client.getOpenInterest).toHaveBeenCalledOnce());
    await ingestor.stop();slow.resolve(11);balance.resolve(account);pos.resolve(position);await pending;
    expect(internal.snapshot).toBe(before);
    for(const callback of Object.values(callbacks))expect(callback).not.toHaveBeenCalled();
    await internal.refreshSupplemental();expect(client.getOpenInterest).toHaveBeenCalledOnce();
  });
  it("recovers the next batch after all upstream components reject", async () => {
    const {client, internal, callbacks, logger}=fixture();
    client.getMarkPrice.mockRejectedValueOnce(new Error("market"));
    client.getBalanceState.mockRejectedValueOnce(new Error("account"));
    client.getPositionState.mockRejectedValueOnce(new Error("position"));
    await internal.refreshSupplemental();expect(logger.warn).toHaveBeenCalledTimes(3);
    for(const callback of Object.values(callbacks))expect(callback).not.toHaveBeenCalled();
    await internal.refreshSupplemental();for(const callback of Object.values(callbacks))expect(callback).toHaveBeenCalledOnce();
  });
  it("contains synchronous client throws and keeps successful components",async()=>{
    const {client, internal, callbacks}=fixture();client.getBalanceState.mockImplementation(()=>{throw new Error("failed");});
    await expect(internal.refreshSupplemental()).resolves.toBeUndefined();
    expect(callbacks.onMarket).toHaveBeenCalledOnce();expect(callbacks.onPosition).toHaveBeenCalledOnce();
  });
  it("keeps a failed public batch single-flight until its other reads settle",async()=>{
    const {client, internal}=fixture();const slow=deferred<number>();
    client.getOpenInterest.mockReturnValue(slow.promise);client.getMarkPrice.mockRejectedValue(new Error("failed"));
    const pending=internal.refreshSupplemental();await vi.waitFor(()=>expect(client.getOpenInterest).toHaveBeenCalledOnce());
    await Promise.resolve();const second=internal.refreshSupplemental();
    expect(client.getMarkPrice).toHaveBeenCalledOnce();slow.resolve(11);await Promise.all([pending,second]);
  });

});
