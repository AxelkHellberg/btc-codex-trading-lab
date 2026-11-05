import { afterEach, describe, expect, it, vi } from "vitest";
import type { TriggerEvaluationResult } from "./triggerEvaluator.js";
import { EventDetector } from "./eventDetector.js";

const completed: TriggerEvaluationResult = { status: "completed" };
const news = [{ id: "headline", source: "fixture", title: "BTC ETF", publishedAt: 1,
  relevanceScore: 1, sentimentScore: 0, tags: ["news"] }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());
describe("evaluation outcome cooldowns", () => {
  it.each(["busy", "no_market", "failed"] as const)("allows immediate retry after %s", async (status) => {
    const callback = vi.fn().mockResolvedValueOnce({ status }).mockResolvedValue(completed);
    const detector = new EventDetector(callback);
    await detector.heartbeat();
    await detector.heartbeat();
    await detector.heartbeat();
    expect(callback).toHaveBeenCalledTimes(2);
  });
  it("retains cooldown for completed work, including a valid risk rejection", async () => {
    vi.useFakeTimers();
    const callback = vi.fn().mockResolvedValue(completed);
    const detector = new EventDetector(callback);
    await detector.heartbeat();
    await vi.advanceTimersByTimeAsync(49_999);
    await detector.heartbeat();
    expect(callback).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await detector.heartbeat();
    expect(callback).toHaveBeenCalledTimes(2);
  });
  it("debounces concurrent same-reason dispatch while work is pending", async () => {
    const pending = deferred<TriggerEvaluationResult>();
    const callback = vi.fn(() => pending.promise);
    const detector = new EventDetector(callback);
    const first = detector.heartbeat();
    await detector.heartbeat();
    expect(callback).toHaveBeenCalledOnce();
    pending.resolve(completed);
    await first;
  });
  it("releases rejected dispatches while preserving the error", async () => {
    const failure = new Error("dispatch down");
    const callback = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(completed);
    const detector = new EventDetector(callback);
    await expect(detector.heartbeat()).rejects.toBe(failure);
    await detector.heartbeat();
    expect(callback).toHaveBeenCalledTimes(2);
  });
  it.each(["failed", "rejected"] as const)("keeps newer same-reason success after an older %s result", async (outcome) => {
    vi.useFakeTimers();
    const pending = deferred<TriggerEvaluationResult>();
    const callback = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(completed);
    const detector = new EventDetector(callback);
    const first = detector.heartbeat();
    const observed = first.catch(() => {});
    await vi.advanceTimersByTimeAsync(50_000);
    await detector.heartbeat();
    if (outcome === "rejected") pending.reject(new Error("old failure"));
    else pending.resolve({ status: "failed" });
    await observed;
    await detector.heartbeat();
    expect(callback).toHaveBeenCalledTimes(2);
  });
  it("tracks each trigger reason independently", async () => {
    const callback = vi.fn().mockResolvedValue(completed);
    const detector = new EventDetector(callback);
    await detector.heartbeat();
    await detector.handleNews(news);
    await detector.handleNews(news);
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
