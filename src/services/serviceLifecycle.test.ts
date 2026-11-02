import { describe, expect, it, vi } from "vitest";
import { ServiceLifecycle, type ManagedService } from "./serviceLifecycle.js";

const service = (name: string, calls: string[], start = async () => {}) => ({
  name, start: async () => { calls.push(`start ${name}`); await start(); },
  stop: async () => { calls.push(`stop ${name}`); }
});

describe("partial startup rollback", () => {
  it("stops the partially started service and earlier resources in reverse order", async () => {
    const lifecycle = new ServiceLifecycle();
    const calls: string[] = [];
    const original = new Error("market startup failed");
    lifecycle.own("Postgres", () => { calls.push("close Postgres"); });
    lifecycle.own("Redis", () => { calls.push("close Redis"); });
    const services = [service("HTTP", calls), service("market", calls, async () => { throw original; }), service("news", calls)];
    await expect(lifecycle.start(services)).rejects.toBe(original);
    expect(calls).toEqual(["start HTTP", "start market", "stop market", "stop HTTP", "close Redis", "close Postgres"]);
    await lifecycle.stop();
    expect(calls).toHaveLength(6);
  });

  it("keeps the startup error while collecting synchronous and asynchronous cleanup failures", async () => {
    const lifecycle = new ServiceLifecycle();
    const original = new Error("startup failed");
    const syncFailure = new Error("synchronous cleanup failure");
    const asyncFailure = new Error("asynchronous cleanup failure");
    const finalCleanup = vi.fn();
    lifecycle.own("store", finalCleanup);
    lifecycle.own("sync", () => { throw syncFailure; });
    const failing: ManagedService = { name: "partial", start: async () => { throw original; }, stop: async () => { throw asyncFailure; } };
    await expect(lifecycle.start([failing])).rejects.toBe(original);
    await expect(lifecycle.stop()).resolves.toEqual([{ name: "partial", error: asyncFailure }, { name: "sync", error: syncFailure }]);
    expect(finalCleanup).toHaveBeenCalledTimes(1);
  });

  it("retains resources on success and shares one teardown across concurrent shutdown requests", async () => {
    const calls: string[] = [];
    const lifecycle = new ServiceLifecycle();
    await lifecycle.start([service("HTTP", calls), service("market", calls)]);
    expect(calls).toEqual(["start HTTP", "start market"]);
    const first = lifecycle.stop();
    expect(lifecycle.stop()).toBe(first);
    await first;
    expect(calls).toEqual(["start HTTP", "start market", "stop market", "stop HTTP"]);
    expect(() => lifecycle.own("late resource", () => {})).toThrow("after teardown begins");
  });

  it("does not begin a later service while its dependency is still starting", async () => {
    const lifecycle = new ServiceLifecycle();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const next = vi.fn(async () => {});
    const started = lifecycle.start([{ name: "first", start: () => pending, stop: () => {} }, { name: "next", start: next, stop: () => {} }]);
    expect(next).not.toHaveBeenCalled();
    release();
    await started;
    expect(next).toHaveBeenCalledTimes(1);
    await lifecycle.stop();
  });
});
