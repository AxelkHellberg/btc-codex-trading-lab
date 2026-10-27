import { describe, expect, it, vi } from "vitest";

import { shutdownServices } from "./shutdownServices.js";

describe("critical shutdown results", () => {
  it("returns success after all services stop", async () => {
    const report = vi.fn();
    const stop = vi.fn();
    expect(await shutdownServices([
      { name: "sync", stop },
      { name: "async", stop: async () => {} }
    ], report)).toBe(0);
    expect(stop).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  it("names a rejected HTTP close and still attempts the other services", async () => {
    const error = new Error("HTTP close failed");
    const report = vi.fn();
    const closeStore = vi.fn().mockResolvedValue(undefined);
    expect(await shutdownServices([
      { name: "httpServer", stop: async () => { throw error; } },
      { name: "store", stop: closeStore }
    ], report)).toBe(1);
    expect(closeStore).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledExactlyOnceWith("httpServer", error);
  });

  it("collects synchronous and asynchronous failures without skipping cleanup", async () => {
    const syncError = new Error("sync stop failed");
    const asyncError = new Error("async close failed");
    const report = vi.fn();
    const finalStop = vi.fn();
    expect(await shutdownServices([
      { name: "newsIngestor", stop: () => { throw syncError; } },
      { name: "hotStore", stop: async () => { throw asyncError; } },
      { name: "store", stop: finalStop }
    ], report)).toBe(1);
    expect(finalStop).toHaveBeenCalledOnce();
    expect(report.mock.calls).toEqual([["newsIngestor", syncError], ["hotStore", asyncError]]);
  });

  it("waits for remaining cleanup even after one service fails", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let settled = false;
    const result = shutdownServices([
      { name: "failed", stop: async () => { throw new Error("failed"); } },
      { name: "pending", stop: () => pending }
    ], vi.fn()).then((code) => { settled = true; return code; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    expect(await result).toBe(1);
  });
});
