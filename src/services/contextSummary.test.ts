import { describe, expect, it } from "vitest";
import type { MarketSnapshot } from "../domain/types.js";
import { buildContextSummary } from "./contextSummary.js";
import { RuntimeState } from "./runtimeState.js";

const market: MarketSnapshot = {
  symbol: "BTCUSDT", markPrice: 100, indexPrice: 100, lastPrice: 100,
  bestBid: 99.9, bestAsk: 100.1, spreadBps: 0.2, fundingRate: 0,
  nextFundingTime: 1, openInterest: 1, openInterestChangePct1m: 0,
  topTraderLongShortRatio: 1, volume1m: 1, priceChangePct1m: 0.4,
  priceChangePct5m: 0.8, priceChangePct15m: 0.2, priceChangePct1h: 0.6,
  intradayHigh: 110, intradayLow: 90, distanceFromIntradayHighPct: 9.09,
  distanceFromIntradayLowPct: 11.11, emaFast: 101, emaMedium: 100,
  trendStrengthPct: 0.18, volumeAcceleration: 1, timestamp: 0,
  filters: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 }
};

describe("shared context summary", () => {
  it.each([
    [{}, "trend_up", "bullish"],
    [{ trendStrengthPct: 0.179 }, "transition", "bullish"],
    [{ emaFast: 99, priceChangePct15m: -0.2, priceChangePct1h: -0.6, trendStrengthPct: -0.18 }, "trend_down", "bearish"],
    [{ emaFast: 99, priceChangePct15m: -0.2, priceChangePct1h: -0.6, trendStrengthPct: -0.179 }, "transition", "bearish"],
    [{ priceChangePct15m: -0.2 }, "transition", "neutral"],
    [{ emaFast: 99, priceChangePct15m: 0.2 }, "transition", "neutral"],
    [{ priceChangePct5m: 0.179, trendStrengthPct: 0.139 }, "range", "bullish"],
    [{ priceChangePct5m: 0.18, trendStrengthPct: 0.139 }, "transition", "bullish"]
  ] as const)("preserves runtime regime and trend boundaries (%j)", (overrides, regime, bias) => {
    const summary = buildContextSummary({ ...market, ...overrides });
    expect(summary.regime).toBe(regime);
    expect(summary.trend_bias).toBe(bias);
  });

  it("keeps runtime momentum weights and precision independent of volume", () => {
    expect(buildContextSummary(market).momentum_score).toBe(0.447);
    expect(buildContextSummary({ ...market, volumeAcceleration: 30 }).momentum_score).toBe(0.447);
  });

  it.each([[0.13, "bullish"], [-0.13, "bearish"], [0.12, "neutral"], [-0.12, "neutral"]] as const)(
    "preserves runtime news sentiment %s", (sentimentScore, expected) => {
      const runtime = new RuntimeState(10_000);
      runtime.setMarket(market);
      runtime.pushNews([{ id: "news", title: "fixture", source: "fixture", url: "https://example.com",
        publishedAt: Date.now(), sentimentScore, relevanceScore: 1, tags: [] }]);
      const context = runtime.buildDecisionContext({ reason: "minute_recheck", priority: 0, details: "test", triggeredAt: 0 },
        { maxDailyLoss: 0.03, maxWeeklyDrawdown: 0.1, cooldownMinutes: 30 });
      expect(context?.context_summary.catalyst_bias).toBe(expected);
      expect(buildContextSummary(market).catalyst_bias).toBe("neutral");
    }
  );
});
