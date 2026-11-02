import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceLifecycle } from "./serviceLifecycle.js";
import { StartupInterrupted, StartupShutdown } from "./startupShutdown.js";
const deferred = () => {
  let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe("shutdown while startup is pending", () => {
  it("cancels subsequent startup and cleans the settled current service exactly once", async () => {
    const lifecycle = new ServiceLifecycle(); const pending = deferred();
    const storeClose = vi.fn(); lifecycle.own("store", storeClose);
    const stop = vi.fn(); const next = vi.fn(); const exit = vi.fn();
    const shutdown = new StartupShutdown(async () => { await lifecycle.stop(); }, exit, vi.fn());
    const startup = lifecycle.start([
      { name: "pending", start: () => pending.promise, stop },
      { name: "next", start: next, stop: vi.fn() }
    ], shutdown.checkpoint);
    const settled = startup.catch(error => { expect(error).toBeInstanceOf(StartupInterrupted); })
      .finally(() => shutdown.finishStartup());
    shutdown.request(); shutdown.request();
    expect(stop).not.toHaveBeenCalled(); expect(exit).not.toHaveBeenCalled();
    pending.resolve(); await settled;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(next).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledOnce();
    expect(storeClose).toHaveBeenCalledOnce(); expect(exit).toHaveBeenCalledOnce();
  });

  it("cleans normally when the signal arrives after startup", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined); const exit = vi.fn();
    const shutdown = new StartupShutdown(cleanup, exit, vi.fn()); shutdown.finishStartup();
    shutdown.request(); await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("forces a nonzero exit if startup cannot settle and never later reports success", async () => {
    vi.useFakeTimers(); const exit = vi.fn(); const report = vi.fn();
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const shutdown = new StartupShutdown(cleanup, exit, report);
    shutdown.request(); await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1); expect(report).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled(); shutdown.finishStartup();
    await vi.advanceTimersByTimeAsync(0); expect(exit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports cleanup failures and genuine startup failures as unsuccessful", async () => {
    const exit = vi.fn(); const report = vi.fn();
    const shutdown = new StartupShutdown(async () => { throw new Error("cleanup failed"); }, exit, report);
    shutdown.finishStartup(true); shutdown.request();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(report).toHaveBeenCalledOnce();
  });
});
