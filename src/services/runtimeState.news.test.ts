import { afterEach, describe, expect, it, vi } from "vitest";

import type { MarketSnapshot, NewsEvent } from "../domain/types.js";
import { RuntimeState } from "./runtimeState.js";

const now = Date.UTC(2026, 9, 24, 15);
const horizon = 24 * 60 * 60 * 1000;
const policy = { maxDailyLoss: 0.02, maxWeeklyDrawdown: 0.05, cooldownMinutes: 60 };
const event = (id: string, publishedAt: number, sentimentScore = 1): NewsEvent => ({
  id, publishedAt, sentimentScore, relevanceScore: 1, source: "fixture", title: id, tags: []
});
const stateWithMarket = (): RuntimeState => {
  const state = new RuntimeState(10_000);
  state.setMarket({
    emaFast: 100, emaMedium: 100, priceChangePct1m: 0, priceChangePct5m: 0,
    priceChangePct15m: 0, priceChangePct1h: 0, trendStrengthPct: 0,
    volumeAcceleration: 1, distanceFromIntradayHighPct: 0, distanceFromIntradayLowPct: 0
  } as MarketSnapshot);
  return state;
};
const context = (state: RuntimeState) => state.buildDecisionContext(
  { reason: "minute_recheck", priority: 0, details: "fixture", triggeredAt: Date.now() }, policy
)!;

afterEach(() => vi.restoreAllMocks());

describe("decision news freshness", () => {
  it("expires at the 24-hour boundary without another feed poll", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const state = stateWithMarket();
    state.pushNews([event("fresh", now)]);
    expect(context(state).context_summary.catalyst_bias).toBe("bullish");
    clock.mockReturnValue(now + horizon - 1);
    expect(context(state).news_events.map(({ id }) => id)).toEqual(["fresh"]);
    clock.mockReturnValue(now + horizon);
    expect(context(state).news_events).toEqual([]);
    expect(context(state).context_summary.catalyst_bias).toBe("neutral");
    // Expiry affects active decision inputs, not historical inspection.
    expect(state.getNews()).toHaveLength(1);
  });

  it("uses only eligible headlines for both sentiment and model input", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const state = stateWithMarket();
    state.pushNews([
      event("expired", now - horizon, 1), event("fresh", now - 1, -1),
      event("future", now + 1, 1), event("invalid", Number.NaN, 1)
    ]);
    expect(context(state).news_events.map(({ id }) => id)).toEqual(["fresh"]);
    expect(context(state).context_summary.catalyst_bias).toBe("bearish");
  });

  it("recovers when fresh news arrives after an outage", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const state = stateWithMarket();
    state.pushNews([event("old", now)]);
    clock.mockReturnValue(now + 30 * horizon);
    expect(context(state).context_summary.catalyst_bias).toBe("neutral");
    state.pushNews([event("recovery", Date.now(), -1)]);
    expect(context(state).news_events.map(({ id }) => id)).toEqual(["recovery"]);
    expect(context(state).context_summary.catalyst_bias).toBe("bearish");
  });

  it("filters before selecting the ten headlines used for a decision", () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const state = stateWithMarket();
    state.pushNews([
      ...Array.from({ length: 12 }, (_, index) => event(`future-${index}`, now + index + 1)),
      ...Array.from({ length: 12 }, (_, index) => event(`fresh-${index}`, now - index))
    ]);
    expect(context(state).news_events.map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `fresh-${index}`)
    );
  });
});
