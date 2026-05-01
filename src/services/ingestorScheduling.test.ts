import { afterEach, describe, expect, it, vi } from "vitest";

import { NewsIngestor } from "./newsIngestor.js";
import { OnchainIngestor } from "./onchainIngestor.js";

const logger = {
  warn: vi.fn()
};

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
};

const createDeferred = (): {
  promise: Promise<void>;
  resolve: () => void;
} => {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });

  return { promise, resolve };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ingestor scheduling", () => {
  it("prevents overlapping news polls while a timer tick is still in flight", async () => {
    vi.useFakeTimers();

    const ingestor = new NewsIngestor(
      { feeds: { news: [], macro: [] } } as never,
      logger as never,
      vi.fn()
    );

    const deferred = createDeferred();
    let calls = 0;
    const pollSpy = vi.spyOn(ingestor as never, "poll").mockImplementation(() => {
      calls += 1;
      if (calls === 2) {
        return deferred.promise;
      }
      return Promise.resolve();
    });

    await ingestor.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pollSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(pollSpy).toHaveBeenCalledTimes(2);

    deferred.resolve();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pollSpy).toHaveBeenCalledTimes(3);

    ingestor.stop();
  });

  it("prevents overlapping on-chain polls while a timer tick is still in flight", async () => {
    vi.useFakeTimers();

    const ingestor = new OnchainIngestor(
      { onchainBaseUrl: "https://example.test" } as never,
      logger as never,
      vi.fn()
    );

    const deferred = createDeferred();
    let calls = 0;
    const pollSpy = vi.spyOn(ingestor as never, "poll").mockImplementation(() => {
      calls += 1;
      if (calls === 2) {
        return deferred.promise;
      }
      return Promise.resolve();
    });

    await ingestor.start();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(pollSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pollSpy).toHaveBeenCalledTimes(2);

    deferred.resolve();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(pollSpy).toHaveBeenCalledTimes(3);

    ingestor.stop();
  });
});
