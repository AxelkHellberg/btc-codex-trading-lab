import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), run: vi.fn(), rm: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn().mockResolvedValue("/tmp/test-schema"),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: mocks.rm
}));
vi.mock("@openai/codex-sdk", () => ({
  Codex: class { startThread() { return { run: mocks.run }; } }
}));
import { CodexDecisionWorker } from "./codexDecisionWorker.js";

const signal = {
  bias: "FLAT", confidence: 0.5, setup_type: "continuation", invalidation_price: null,
  holding_horizon_minutes: 30, reasoning_summary: "No confirmed directional setup."
};
const validLine = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(signal) } });

afterEach(() => vi.clearAllMocks());
const begin = async (stdout: string) => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn() }
  });
  mocks.spawn.mockReturnValue(child);
  mocks.run.mockRejectedValue(new Error("SDK unavailable"));
  const worker = new CodexDecisionWorker({ codex: { model: "test", timeoutMs: 1000, useCliFallback: true } } as never, { warn: vi.fn() } as never);
  const result = worker.decide({ market_snapshot: { symbol: "BTCUSDT" }, trigger: {}, context_summary: {} } as never);
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));
  child.stdout.emit("data", Buffer.from(stdout));
  return { child, result };
};

describe("CLI event decoding", () => {
  it.each(["{\"type\":", validLine + "\n{broken", "{broken\n" + validLine])("rejects malformed event output through the promise: %s", async (output) => {
    const { child, result } = await begin(output);
    const rejected = expect(result).rejects.toThrow("Codex CLI emitted invalid JSON event output");
    expect(() => child.emit("close", 0)).not.toThrow();
    await rejected;
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/test-schema", { recursive: true, force: true });
  });
  it.each(["null", "42", "[]", JSON.stringify({ type: "item.completed", item: null })])("handles irrelevant JSON event values without throwing: %s", async (output) => {
    const { child, result } = await begin(output);
    const rejected = expect(result).rejects.toThrow("No agent_message found");
    expect(() => child.emit("close", 0)).not.toThrow();
    await rejected;
    expect(mocks.rm).toHaveBeenCalled();
  });
  it("uses the last completed agent message among valid events", async () => {
    const { child, result } = await begin(validLine + "\n" + JSON.stringify({ type: "turn.completed" }));
    child.emit("close", 0);
    await expect(result).resolves.toMatchObject({ bias: "FLAT", invalidation_price: undefined });
    expect(mocks.rm).toHaveBeenCalled();
  });
});
