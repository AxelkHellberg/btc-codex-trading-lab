import { afterEach, describe, expect, it, vi } from "vitest";

import { NewsIngestor } from "./newsIngestor.js";
import { OnchainIngestor } from "./onchainIngestor.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

const factories = [
  ["news", 60_000, () => new NewsIngestor(
    { feeds: { news: [], macro: [] } } as never, { warn: vi.fn() } as never, vi.fn()
  )],
  ["on-chain", 300_000, () => new OnchainIngestor(
    { onchainBaseUrl: "https://example.test" } as never, { warn: vi.fn() } as never, vi.fn()
  )]
] as const;

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

for (const [name, interval, create] of factories) {
  describe(`${name} ingestor start ownership`, () => {
    it("shares startup and retains exactly one interval after repeated starts", async () => {
      vi.useFakeTimers();
      const ingestor = create();
      const initial = deferred();
      const poll = vi.spyOn(ingestor as unknown as { poll(): Promise<void> }, "poll")
        .mockResolvedValue(undefined).mockImplementationOnce(() => initial.promise);
      const first = ingestor.start();
      let secondFinished = false;
      const second = ingestor.start().then(() => { secondFinished = true; });
      await Promise.resolve();
      expect(secondFinished).toBe(false);
      expect(poll).toHaveBeenCalledTimes(1);
      initial.resolve();
      await Promise.all([first, second]);
      await ingestor.start();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(interval);
      expect(poll).toHaveBeenCalledTimes(2);
      ingestor.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("does not install a timer when stop interrupts initial polling", async () => {
      vi.useFakeTimers();
      const ingestor = create();
      const initial = deferred();
      const poll = vi.spyOn(ingestor as unknown as { poll(): Promise<void> }, "poll")
        .mockResolvedValue(undefined).mockImplementationOnce(() => initial.promise);
      const starting = ingestor.start();
      ingestor.stop();
      initial.resolve();
      await starting;
      expect(vi.getTimerCount()).toBe(0);
      await ingestor.start();
      expect(poll).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
      ingestor.stop();
    });

    it("keeps only the replacement timer during a stop/start race", async () => {
      vi.useFakeTimers();
      const ingestor = create();
      const initial = deferred();
      vi.spyOn(ingestor as unknown as { poll(): Promise<void> }, "poll")
        .mockImplementation(() => initial.promise);
      const oldStart = ingestor.start();
      ingestor.stop();
      const newStart = ingestor.start();
      initial.resolve();
      await Promise.all([oldStart, newStart]);
      expect(vi.getTimerCount()).toBe(1);
      ingestor.stop();
      ingestor.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("permits retry after initial polling rejects", async () => {
      vi.useFakeTimers();
      const ingestor = create();
      const poll = vi.spyOn(ingestor as unknown as { poll(): Promise<void> }, "poll")
        .mockRejectedValueOnce(new Error("sink failed")).mockResolvedValue(undefined);
      await expect(ingestor.start()).rejects.toThrow("sink failed");
      expect(vi.getTimerCount()).toBe(0);
      await ingestor.start();
      expect(poll).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
      ingestor.stop();
    });
  });
}
