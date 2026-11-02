import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { DecisionContext } from "../domain/types.js";

const mocks = vi.hoisted(() => ({ run: vi.fn(), spawn: vi.fn(), rm: vi.fn(), writeFile: vi.fn() }));
vi.mock("@openai/codex-sdk", () => ({ Codex: class { startThread() { return { run: mocks.run }; } } }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => "/tmp/decision-timeout-test"),
  writeFile: mocks.writeFile,
  rm: mocks.rm
}));
const { CodexDecisionWorker } = await import("./codexDecisionWorker.js");
const context = { market_snapshot: { symbol: "BTCUSDT" }, trigger: {}, context_summary: {} } as DecisionContext;
const signal = { bias: "FLAT", confidence: 0.5, setup_type: "breakout", holding_horizon_minutes: 5,
  reasoning_summary: "Waiting for price confirmation", invalidation_price: null };
const makeChild = () => Object.assign(new EventEmitter(), {
  pid: 2_000_000, stdout: new EventEmitter(), stderr: new EventEmitter(),
  stdin: { write: vi.fn(), end: vi.fn() }, kill: vi.fn()
});
const worker = () => new CodexDecisionWorker({ ...config, codex: {
  ...config.codex, timeoutMs: 1000, useCliFallback: true
} }, { warn: vi.fn() } as unknown as Logger);

describe("CLI fallback deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.clearAllMocks();
    mocks.run.mockRejectedValue(new Error("SDK unavailable"));
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("kills a stalled CLI group and removes the schema directory without waiting for close", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const result = worker().decide(context);
    const rejected = expect(result).rejects.toThrow("timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/decision-timeout-test", { recursive: true, force: true });
    // A late close must not parse malformed output or start another fallback.
    child.stdout.emit("data", "invalid JSON");
    expect(() => child.emit("close", 0)).not.toThrow();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the decision budget with SDK work instead of granting a second timeout", async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    mocks.run.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("SDK failed")), 700)));
    const rejected = expect(worker().decide(context)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(999);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("does not launch a CLI after the SDK exhausts the budget", async () => {
    mocks.run.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("SDK timed out")), 1000)));
    const rejected = expect(worker().decide(context)).rejects.toThrow("deadline expired before CLI fallback");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])("clears the deadline after a normal CLI close with code %s", async (code) => {
    const child = makeChild();
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(signal) } }));
        child.emit("close", code);
      });
      return child;
    });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    if (code === 0) await expect(worker().decide(context)).resolves.toMatchObject({ bias: "FLAT" });
    else await expect(worker().decide(context)).rejects.toThrow("code 1");
    await vi.advanceTimersByTimeAsync(2000);
    expect(kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline and cleans up after spawn fails", async () => {
    const child = makeChild();
    mocks.spawn.mockImplementation(() => { queueMicrotask(() => child.emit("error", new Error("ENOENT"))); return child; });
    await expect(worker().decide(context)).rejects.toThrow("ENOENT");
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
  });
});
