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
    getPositionState: vi.fn().mockResolvedValue(position)
  };
  const logger = { warn: vi.fn() };
  const ingestor = new MarketIngestor(
    { symbol: "BTCUSDT", tradingMode: mode } as AppConfig,
    client as unknown as BinanceFuturesClient, logger as unknown as Logger, callbacks
  );
  const internal = ingestor as unknown as { snapshot: MarketSnapshot; refreshSupplemental(): Promise<void> };
  internal.snapshot = { ...market };
  return { callbacks, client, logger, internal };
};

describe("supplemental callback delivery", () => {
  it("delivers all three successfully fetched values", async () => {
    const { callbacks, internal, logger } = fixture();
    await internal.refreshSupplemental();
    expect(callbacks.onMarket).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ markPrice: 101, openInterest: 11 }));
    expect(callbacks.onAccount).toHaveBeenCalledExactlyOnceWith(account);
    expect(callbacks.onPosition).toHaveBeenCalledExactlyOnceWith(position);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(["onMarket", "onAccount", "onPosition"] as const)("isolates a rejected %s sink", async (name) => {
    const { callbacks, internal, logger } = fixture();
    callbacks[name].mockRejectedValue(new Error("private-account-data"));
    await expect(internal.refreshSupplemental()).resolves.toBeUndefined();
    for (const callback of Object.values(callbacks)) expect(callback).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith({ callback: name }, "Supplemental market callback failed");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private-account-data");
  });

  it.each(["onMarket", "onAccount", "onPosition"] as const)("isolates a synchronous throw in %s", async (name) => {
    const { callbacks, internal } = fixture();
    callbacks[name].mockImplementation(() => { throw new Error("callback failed"); });
    await internal.refreshSupplemental();
    for (const callback of Object.values(callbacks)) expect(callback).toHaveBeenCalledTimes(1);
  });

  it("observes every rejection when all sinks fail", async () => {
    const { callbacks, internal, logger } = fixture();
    for (const callback of Object.values(callbacks)) callback.mockRejectedValue(new Error("failed"));
    await expect(internal.refreshSupplemental()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it("allows independent sinks to complete while the market sink is pending", async () => {
    const { callbacks, internal } = fixture();
    let reject!: (reason: Error) => void;
    callbacks.onMarket.mockReturnValue(new Promise<void>((_resolve, fail) => { reject = fail; }));
    const pending = internal.refreshSupplemental();
    await vi.waitFor(() => expect(callbacks.onMarket).toHaveBeenCalledOnce());
    expect(callbacks.onAccount).toHaveBeenCalledOnce();
    reject(new Error("market failed"));
    await pending;
    expect(callbacks.onAccount).toHaveBeenCalledOnce();
    expect(callbacks.onPosition).toHaveBeenCalledOnce();
  });

  it("retains a failed market snapshot while delivering private results", async () => {
    const { client, callbacks, internal, logger } = fixture();
    client.getMarkPrice.mockRejectedValue(new Error("upstream failed"));
    const before = internal.snapshot;
    await internal.refreshSupplemental();
    expect(internal.snapshot).toBe(before);
    expect(callbacks.onMarket).not.toHaveBeenCalled();
    expect(callbacks.onAccount).toHaveBeenCalledOnce();
    expect(callbacks.onPosition).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith({component: "market"}, "Supplemental upstream read failed");
  });

  it("does not fetch or deliver account state in paper mode", async () => {
    const { client, callbacks, internal } = fixture("paper");
    callbacks.onMarket.mockRejectedValue(new Error("failed"));
    await internal.refreshSupplemental();
    expect(client.getBalanceState).not.toHaveBeenCalled();
    expect(client.getPositionState).not.toHaveBeenCalled();
    expect(callbacks.onAccount).not.toHaveBeenCalled();
    expect(callbacks.onPosition).not.toHaveBeenCalled();
  });
});
