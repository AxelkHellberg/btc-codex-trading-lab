import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { EventDetector } from "./eventDetector.js";
import { MarketIngestor } from "./marketIngestor.js";

const snapshot = (): MarketSnapshot => ({
  symbol: "BTCUSDT", markPrice: 100, indexPrice: 100, lastPrice: 100,
  bestBid: 99, bestAsk: 101, spreadBps: 0, fundingRate: 0, nextFundingTime: 0,
  openInterest: 100, openInterestChangePct1m: 0.5, topTraderLongShortRatio: 1,
  volume1m: 0, priceChangePct1m: 0, priceChangePct5m: 0, priceChangePct15m: 0,
  priceChangePct1h: 0, intradayHigh: 100, intradayLow: 100,
  distanceFromIntradayHighPct: 0, distanceFromIntradayLowPct: 0,
  emaFast: 100, emaMedium: 100, trendStrengthPct: 0, volumeAcceleration: 0,
  timestamp: Date.now(), openInterestObservedAt: Date.now()
} as MarketSnapshot);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-26T09:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("open-interest observation consumption", () => {
  it("reserves an observation while its dispatch is still in flight", async () => {
    let finish!: () => void;
    const onTrigger = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const detector = new EventDetector(onTrigger);
    const first = snapshot();
    const pending = detector.handleMarket(first);
    vi.advanceTimersByTime(21_000);
    await detector.handleMarket(first);
    expect(onTrigger).toHaveBeenCalledOnce();
    finish();
    await pending;
    vi.advanceTimersByTime(21_000);
    await detector.handleMarket(first);
    expect(onTrigger).toHaveBeenCalledOnce();
  });

  it("deduplicates legacy snapshots without an observation timestamp by their OI values", async () => {
    const onTrigger = vi.fn();
    const detector = new EventDetector(onTrigger);
    const first = snapshot();
    delete first.openInterestObservedAt;
    await detector.handleMarket(first);
    vi.advanceTimersByTime(21_000);
    await detector.handleMarket({ ...first, timestamp: Date.now() });
    expect(onTrigger).toHaveBeenCalledOnce();
    await detector.handleMarket({ ...first, openInterest: 101 });
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("does not consume one supplemental observation again on later market frames", async () => {
    const onTrigger = vi.fn();
    const detector = new EventDetector(onTrigger);
    const client = {
      getMarkPrice: vi.fn().mockResolvedValue({ markPrice: 100, indexPrice: 100, fundingRate: 0, nextFundingTime: 0 }),
      getOpenInterest: vi.fn().mockResolvedValue(100.5),
      getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1)
    } as unknown as BinanceFuturesClient;
    const ingestor = new MarketIngestor({ symbol: "BTCUSDT", tradingMode: "paper" } as AppConfig, client, { warn: vi.fn() } as unknown as Logger, {
      onMarket: (value) => detector.handleMarket(value), onAccount: vi.fn(), onPosition: vi.fn()
    });
    const internal = ingestor as unknown as { snapshot: MarketSnapshot; lastOpenInterest: number; refreshSupplemental(): Promise<void>; handleMarketMessage(raw: string): Promise<void> };
    internal.snapshot = snapshot();
    internal.lastOpenInterest = 100;
    await internal.refreshSupplemental();
    for (let n = 0; n < 3; n++) {
      vi.advanceTimersByTime(21_000);
      await internal.handleMarketMessage(JSON.stringify({ data: { e: "bookTicker", b: "99", a: "101", E: Date.now() } }));
    }
    expect(onTrigger.mock.calls.filter(([t]) => t.reason === "open_interest_spike")).toHaveLength(1);
    expect(internal.snapshot.openInterestChangePct1m).toBeCloseTo(0.5);
    client.getOpenInterest = vi.fn().mockResolvedValue(101.0025);
    await internal.refreshSupplemental();
    expect(onTrigger.mock.calls.filter(([t]) => t.reason === "open_interest_spike")).toHaveLength(2);
  });

  it("accepts a new observation even when its values match the preceding one", async () => {
    const onTrigger = vi.fn();
    const detector = new EventDetector(onTrigger);
    const first = snapshot();
    await detector.handleMarket(first);
    vi.advanceTimersByTime(60_000);
    await detector.handleMarket({ ...first, openInterestObservedAt: Date.now() } as MarketSnapshot);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("keeps breakout and funding checks responsive while suppressing repeated OI", async () => {
    const onTrigger = vi.fn();
    const detector = new EventDetector(onTrigger);
    const first = snapshot();
    await detector.handleMarket(first);
    vi.advanceTimersByTime(21_000);
    await detector.handleMarket({ ...first, priceChangePct1m: 0.5, fundingRate: 0.001 });
    expect(onTrigger.mock.calls.map(([t]) => t.reason)).toEqual(["open_interest_spike", "market_breakout", "funding_extreme"]);
  });

  it("leaves a newer observation retryable when the cooldown suppresses it", async () => {
    const onTrigger = vi.fn();
    const detector = new EventDetector(onTrigger);
    const first = snapshot();
    await detector.handleMarket(first);
    vi.advanceTimersByTime(10_000);
    const second = { ...first, openInterestObservedAt: Date.now() } as MarketSnapshot;
    await detector.handleMarket(second);
    vi.advanceTimersByTime(11_000);
    await detector.handleMarket(second);
    expect(onTrigger).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(21_000);
    await detector.handleMarket(second);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });

  it("allows a failed dispatch to retry after cooldown", async () => {
    const onTrigger = vi.fn().mockRejectedValueOnce(new Error("decision unavailable")).mockResolvedValue(undefined);
    const detector = new EventDetector(onTrigger);
    const first = snapshot();
    await expect(detector.handleMarket(first)).rejects.toThrow("decision unavailable");
    vi.advanceTimersByTime(21_000);
    await detector.handleMarket(first);
    vi.advanceTimersByTime(21_000);
    await detector.handleMarket(first);
    expect(onTrigger).toHaveBeenCalledTimes(2);
  });
});
