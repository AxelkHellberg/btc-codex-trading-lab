import { describe, expect, it, vi } from "vitest";

import { EventDetector } from "./eventDetector.js";

describe("EventDetector", () => {
  it("emits breakout trigger on strong market move", async () => {
    const onTrigger = vi.fn();
    const detector = new EventDetector(onTrigger);

    await detector.handleMarket({
      symbol: "BTCUSDT",
      markPrice: 100_000,
      indexPrice: 100_000,
      lastPrice: 100_000,
      bestBid: 99_999,
      bestAsk: 100_001,
      spreadBps: 0.2,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 60_000,
      openInterest: 10,
      openInterestChangePct1m: 0.5,
      topTraderLongShortRatio: 1.2,
      volume1m: 1,
      priceChangePct1m: 0.5,
      priceChangePct5m: 1.1,
      priceChangePct15m: 1.6,
      priceChangePct1h: 2.8,
      intradayHigh: 100500,
      intradayLow: 99000,
      distanceFromIntradayHighPct: 0.5,
      distanceFromIntradayLowPct: 1,
      emaFast: 100100,
      emaMedium: 99850,
      trendStrengthPct: 0.25,
      volumeAcceleration: 1.8,
      timestamp: Date.now()
    });

    expect(onTrigger).toHaveBeenCalled();
    const reasons = onTrigger.mock.calls.map(([trigger]) => trigger.reason);
    expect(reasons).toContain("market_breakout");
    expect(reasons).toContain("open_interest_spike");
  });

  it("emits OI spike on a smaller move after recalibration", async () => {
    const onTrigger = vi.fn();
    const detector = new EventDetector(onTrigger);

    await detector.handleMarket({
      symbol: "BTCUSDT",
      markPrice: 100_000,
      indexPrice: 100_000,
      lastPrice: 100_000,
      bestBid: 99_999,
      bestAsk: 100_001,
      spreadBps: 0.2,
      fundingRate: 0.0001,
      nextFundingTime: Date.now() + 60_000,
      openInterest: 10,
      openInterestChangePct1m: 0.3,
      topTraderLongShortRatio: 1.2,
      volume1m: 1,
      priceChangePct1m: 0.04,
      priceChangePct5m: 0.08,
      priceChangePct15m: 0.15,
      priceChangePct1h: 0.2,
      intradayHigh: 100500,
      intradayLow: 99000,
      distanceFromIntradayHighPct: 0.5,
      distanceFromIntradayLowPct: 1,
      emaFast: 100050,
      emaMedium: 99990,
      trendStrengthPct: 0.06,
      volumeAcceleration: 1.1,
      timestamp: Date.now()
    });

    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger.mock.calls[0]?.[0].reason).toBe("open_interest_spike");
  });

  it("retries the same trigger immediately after onTrigger rejects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    try {
      const onTrigger = vi
        .fn()
        .mockRejectedValueOnce(new Error("redis unavailable"))
        .mockResolvedValueOnce(undefined);
      const detector = new EventDetector(onTrigger);

      await expect(detector.heartbeat()).rejects.toThrow("redis unavailable");
      await detector.heartbeat();

      expect(onTrigger).toHaveBeenCalledTimes(2);
      expect(onTrigger.mock.calls[0]?.[0].reason).toBe("minute_recheck");
      expect(onTrigger.mock.calls[1]?.[0].reason).toBe("minute_recheck");
    } finally {
      vi.useRealTimers();
    }
  });
});
