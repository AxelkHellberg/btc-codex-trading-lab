import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketSnapshot, NewsEvent } from "../domain/types.js";
import { RuntimeState } from "./runtimeState.js";

const event = (id: string, publishedAt: number, relevanceScore = 0.1, sentimentScore = -1): NewsEvent => ({
  id, title: id, source: "fixture", publishedAt: 1_790_000_000_000 + publishedAt, relevanceScore, sentimentScore, tags: []
});
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(1_790_000_001_000));
afterEach(() => vi.restoreAllMocks());
function setup() {
  const state = new RuntimeState(1000);
  state.setMarket({priceChangePct1m: 0, priceChangePct5m: 0, priceChangePct15m: 0,
    priceChangePct1h: 0, trendStrengthPct: 0, emaFast: 100, emaMedium: 100,
    volumeAcceleration: 1, intradayHigh: 100, intradayLow: 100,
    distanceFromIntradayHighPct: 0, distanceFromIntradayLowPct: 0} as MarketSnapshot);
  const context = () => state.buildDecisionContext(
    {reason: "minute_recheck", priority: 0, details: "fixture", triggeredAt: 0},
    {maxDailyLoss: 0.1, maxWeeklyDrawdown: 0.2, cooldownMinutes: 10}
  )!;
  return { state, context };
}
describe("decision news ranking", () => {
  it("selects relevant older headlines and computes sentiment from that same selection", () => {
    const {state, context} = setup();
    const signal = Array.from({length: 10}, (_, i) => event(`signal-${i}`, 100 + i, 1, 1));
    const noise = Array.from({length: 10}, (_, i) => event(`noise-${i}`, 200 + i));
    state.pushNews(signal);
    state.pushNews(noise);
    const chronological = state.getNews();
    const result = context();
    expect(result.news_events.map(item => item.id)).toEqual([...signal].reverse().map(item => item.id));
    expect(result.context_summary.catalyst_bias).toBe("bullish");
    expect(state.getNews()).toEqual(chronological);
    expect(state.getNews()[0]?.id).toBe("noise-9");
  });
  it("breaks equal relevance ties by recency", () => {
    const {state, context} = setup();
    state.pushNews([event("older", 1, 0.8), event("newer", 2, 0.8), event("best", 0, 1)]);
    expect(context().news_events.map(item => item.id)).toEqual(["best", "newer", "older"]);
  });
  it("keeps the recency retention limit and updates duplicate scores before ranking", () => {
    const {state, context} = setup();
    state.pushNews([event("evicted", 0, 1), ...Array.from({length: 25}, (_, i) => event(String(i), i + 1))]);
    state.pushNews([event("0", 1, 0.9, 1)]);
    expect(state.getNews()).toHaveLength(25);
    expect(context().news_events[0]?.id).toBe("0");
    expect(context().news_events).toHaveLength(10);
    expect(context().news_events.some(item => item.id === "evicted")).toBe(false);
    expect(state.getNews().filter(item => item.id === "0")).toHaveLength(1);
  });
  it("keeps empty and zero-weight contexts neutral", () => {
    const {state, context} = setup();
    expect(context().news_events).toEqual([]);
    expect(context().context_summary.catalyst_bias).toBe("neutral");
    state.pushNews([event("zero", 1, 0, 1)]);
    expect(context().context_summary.catalyst_bias).toBe("neutral");
  });
});
