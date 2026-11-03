import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvaluationTrigger, MarketSnapshot, NewsEvent, OnchainSnapshot } from "../domain/types.js";
import { EventDetector } from "./eventDetector.js";

const market = { priceChangePct1m: 0, priceChangePct5m: 0, openInterestChangePct1m: 0,
  fundingRate: 0 } as MarketSnapshot;
const headline = (title = "startup headline", tags: string[] = []): NewsEvent => ({
  id: title, source: "fixture", title, tags, relevanceScore: 0.9
} as NewsEvent);
const onchain = (fastestFee = 31) => ({ fastestFee, blockCadenceSeconds: 600 } as OnchainSnapshot);
const setup = () => {
  let latest: MarketSnapshot | null = null;
  const onTrigger = vi.fn<(trigger: EvaluationTrigger) => Promise<void>>().mockResolvedValue(undefined);
  const detector = new EventDetector(onTrigger, () => latest);
  return { detector, onTrigger, ready: () => { latest = market; } };
};
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-03T09:00:00Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("startup catalyst delivery", () => {
  it.each([{ tags: [] }, { tags: ["macro"] }])("defers a relevant headline $tags until market context exists", async ({ tags }) => {
    const x = setup(); await x.detector.handleNews([headline("first", tags)]);
    expect(x.onTrigger).not.toHaveBeenCalled(); x.ready(); await x.detector.handleMarket(market);
    expect(x.onTrigger).toHaveBeenCalledOnce();
    expect(x.onTrigger.mock.calls[0]![0].reason).toBe(tags.length ? "macro_relevant" : "news_relevant");
    await x.detector.handleMarket(market); expect(x.onTrigger).toHaveBeenCalledOnce();
  });
  it("keeps the newest pending trigger per kind without burning cooldown", async () => {
    const x = setup(); await x.detector.handleNews([headline("old")]);
    await vi.advanceTimersByTimeAsync(1); await x.detector.handleNews([headline("new")]);
    await x.detector.handleOnchain(onchain(31)); await x.detector.handleOnchain(onchain(40));
    x.ready(); await x.detector.handleMarket(market);
    expect(x.onTrigger.mock.calls.map(([trigger]) => trigger.details)).toEqual([
      "fixture: new", "mempool fee=40 cadence=600s"
    ]);
  });
  it("bounds the buffer across repeated startup polls to three catalyst kinds", async () => {
    const x = setup();
    for (let i = 0; i < 100; i++) {
      await x.detector.handleNews([headline(`news ${i}`)]);
      await x.detector.handleNews([headline(`macro ${i}`, ["macro"])]);
      await x.detector.handleOnchain(onchain(30 + i));
    }
    expect(x.onTrigger).not.toHaveBeenCalled(); x.ready(); await x.detector.handleMarket(market);
    expect(x.onTrigger).toHaveBeenCalledTimes(3);
    expect(x.onTrigger.mock.calls[0]![0].details).toBe("fixture: news 99");
    expect(x.onTrigger.mock.calls[1]![0].details).toBe("fixture: macro 99");
    expect(x.onTrigger.mock.calls[2]![0].details).toContain("fee=129");
  });
  it("shares a flush between concurrent first market callbacks", async () => {
    const x = setup(); await x.detector.handleNews([headline()]);
    let finish!: () => void; x.onTrigger.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    x.ready(); const first = x.detector.handleMarket(market); const second = x.detector.handleMarket(market);
    expect(x.onTrigger).toHaveBeenCalledOnce(); finish(); await Promise.all([first, second]);
    expect(x.onTrigger).toHaveBeenCalledOnce();
  });
  it("retains a failed deferred dispatch for the next market callback", async () => {
    const x = setup(); await x.detector.handleOnchain(onchain()); x.ready();
    x.onTrigger.mockRejectedValueOnce(new Error("fixture failure"));
    await expect(x.detector.handleMarket(market)).rejects.toThrow("fixture failure");
    await x.detector.handleMarket(market); expect(x.onTrigger).toHaveBeenCalledTimes(2);
    await x.detector.handleMarket(market); expect(x.onTrigger).toHaveBeenCalledTimes(2);
  });
  it("preserves immediate delivery without a provider and ignores irrelevant news", async () => {
    const onTrigger = vi.fn(); const detector = new EventDetector(onTrigger);
    await detector.handleNews([{ ...headline(), relevanceScore: 0.1 }]); expect(onTrigger).not.toHaveBeenCalled();
    await detector.handleNews([headline()]); expect(onTrigger).toHaveBeenCalledOnce();
  });
});
