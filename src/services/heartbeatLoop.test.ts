import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startHeartbeatLoop } from "./heartbeatLoop.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("scheduled heartbeat lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for the interval and isolates a persistence failure from rechecks", async () => {
    const error = new Error("database unavailable");
    const persist = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const recheck = vi.fn().mockResolvedValue(undefined);
    const report = vi.fn();
    const loop = startHeartbeatLoop(persist, recheck, report);
    expect(persist).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(report).toHaveBeenCalledExactlyOnceWith("persist", error);
    expect(recheck).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(recheck).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("observes recheck rejections and accepts the next cycle", async () => {
    const error = new Error("redis unavailable");
    const recheck = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const report = vi.fn();
    const loop = startHeartbeatLoop(async () => {}, recheck, report);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(report).toHaveBeenCalledExactlyOnceWith("recheck", error);
    expect(recheck).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("does not overlap slow writes and drains before dependency teardown", async () => {
    const write = deferred();
    const persist = vi.fn(() => write.promise);
    const recheck = vi.fn().mockResolvedValue(undefined);
    const loop = startHeartbeatLoop(persist, recheck, vi.fn());
    await vi.advanceTimersByTimeAsync(180_000);
    expect(persist).toHaveBeenCalledOnce();
    const teardown = vi.fn();
    const stopped = loop.stop().then(teardown);
    await Promise.resolve();
    expect(teardown).not.toHaveBeenCalled();
    write.resolve();
    await stopped;
    expect(teardown).toHaveBeenCalledOnce();
    expect(recheck).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(persist).toHaveBeenCalledOnce();
    await loop.stop();
  });

  it("also waits for an active scheduled evaluation without starting another", async () => {
    const evaluation = deferred();
    const recheck = vi.fn(() => evaluation.promise);
    const loop = startHeartbeatLoop(async () => {}, recheck, vi.fn());
    await vi.advanceTimersByTimeAsync(180_000);
    expect(recheck).toHaveBeenCalledOnce();
    let drained = false;
    const stopped = loop.stop().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    evaluation.resolve();
    await stopped;
    expect(drained).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes synchronous task failures as well", async () => {
    const error = new Error("synchronous failure");
    const report = vi.fn();
    const loop = startHeartbeatLoop(() => { throw error; }, async () => {}, report);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(report).toHaveBeenCalledExactlyOnceWith("persist", error);
    await loop.stop();
  });
});
