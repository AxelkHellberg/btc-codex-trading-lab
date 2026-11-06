import type { Logger } from "pino";
import { afterEach, expect, it, vi } from "vitest";
import { DecisionLease, DecisionLeaseLostError } from "./decisionLease.js";

function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const store = { acquireLock: vi.fn(async () => true), renewLock: vi.fn(async () => true), releaseLock: vi.fn(async () => {}) };
  const lease = new DecisionLease(store, { warn: vi.fn() } as unknown as Logger);
  return { store, lease };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); });

it("renews a long evaluation beyond the original 55-second expiry", async () => {
  const { store, lease } = setup(); const decide = deferred(); const execute = vi.fn();
  const first = lease.run("a", async (assertOwned) => { await decide.promise; await assertOwned(); execute(); });
  await vi.advanceTimersByTimeAsync(120000);
  expect(store.renewLock.mock.calls.length).toBeGreaterThan(5);
  expect(await lease.run("b", async () => {})).toBe(false);
  expect(store.acquireLock).toHaveBeenCalledOnce();
  decide.resolve(); await expect(first).resolves.toBe(true);
  expect(execute).toHaveBeenCalledOnce(); expect(store.releaseLock).toHaveBeenCalledWith("decision-loop", "a");
  expect(vi.getTimerCount()).toBe(0);
});
it.each(["mismatch", "failure"])("prevents execution after renewal %s and holds local single-flight until work drains", async (mode) => {
  const { store, lease } = setup(); const decide = deferred(); const execute = vi.fn();
  if (mode === "mismatch") store.renewLock.mockResolvedValue(false);
  else store.renewLock.mockRejectedValue(new Error("Redis unavailable"));
  const first = lease.run("a", async (assertOwned) => { await decide.promise; await assertOwned(); execute(); });
  const assertion = expect(first).rejects.toBeInstanceOf(DecisionLeaseLostError);
  await vi.advanceTimersByTimeAsync(60000);
  expect(await lease.run("b", async () => {})).toBe(false);
  decide.resolve(); await assertion; expect(execute).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("checks current ownership immediately before execution even between timer ticks", async () => {
  const { store, lease } = setup(); const execute = vi.fn(); store.renewLock.mockResolvedValue(false);
  await expect(lease.run("a", async (assertOwned) => { await assertOwned(); execute(); })).rejects.toBeInstanceOf(DecisionLeaseLostError);
  expect(execute).not.toHaveBeenCalled();
});
it("does not release another process's busy lock", async () => {
  const { store, lease } = setup(); store.acquireLock.mockResolvedValue(false);
  expect(await lease.run("a", vi.fn())).toBe(false);
  expect(store.releaseLock).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it("cleans up after work fails and admits the next local evaluation", async () => {
  const { store, lease } = setup(); const error = new Error("model failed");
  await expect(lease.run("a", async () => { throw error; })).rejects.toBe(error);
  expect(await lease.run("b", async (assertOwned) => { await assertOwned(); })).toBe(true);
  expect(store.releaseLock).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
});
it("waits for an in-flight refresh before releasing and never overlaps refresh calls", async () => {
  const { store, lease } = setup(); const refresh = deferred(); const work = deferred();
  store.renewLock.mockImplementation(async () => { await refresh.promise; return true; });
  const first = lease.run("a", async () => { await work.promise; });
  await vi.advanceTimersByTimeAsync(20000); work.resolve(); await vi.advanceTimersByTimeAsync(10000);
  expect(store.renewLock).toHaveBeenCalledOnce(); expect(store.releaseLock).not.toHaveBeenCalled();
  refresh.resolve(); await first; expect(store.releaseLock).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects a renewal that completes after the last confirmed lease expires", async () => {
  const { store, lease } = setup(); const refresh = deferred(); const work = deferred(); const execute = vi.fn();
  store.renewLock.mockImplementation(async () => { await refresh.promise; return true; });
  const first = lease.run("a", async (assertOwned) => { await work.promise; await assertOwned(); execute(); });
  const assertion = expect(first).rejects.toBeInstanceOf(DecisionLeaseLostError);
  await vi.advanceTimersByTimeAsync(60000); refresh.resolve(); work.resolve(); await assertion;
  expect(execute).not.toHaveBeenCalled();
});
it("shares a checkpoint refresh with a concurrent timer tick", async () => {
  const { store, lease } = setup(); const renewal = deferred();
  store.renewLock.mockImplementation(async () => { await renewal.promise; return true; });
  const first = lease.run("a", async (assertOwned) => { await assertOwned(); });
  await vi.advanceTimersByTimeAsync(20000);
  expect(store.renewLock).toHaveBeenCalledOnce();
  renewal.resolve(); await first; expect(vi.getTimerCount()).toBe(0);
});
it("reports lost ownership after in-flight execution drains without replaying it", async () => {
  const { store, lease } = setup(); const execution = deferred(); const execute = vi.fn(async () => { await execution.promise; });
  const first = lease.run("a", async (assertOwned) => { await assertOwned(); await execute(); });
  const assertion = expect(first).rejects.toBeInstanceOf(DecisionLeaseLostError);
  await vi.advanceTimersByTimeAsync(0); store.renewLock.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(20000); execution.resolve(); await assertion;
  expect(execute).toHaveBeenCalledOnce(); expect(store.releaseLock).toHaveBeenCalledOnce();
});
