import { access } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import type { Logger } from "pino";
import { expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { DecisionContext } from "../domain/types.js";

const observed = vi.hoisted(() => ({ directory: "", child: undefined as ChildProcess | undefined, closed: undefined as Promise<unknown> | undefined }));
vi.mock("@openai/codex-sdk", () => ({ Codex: class { startThread() { return { run: async () => { throw new Error("offline test fallback"); } }; } } }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, mkdtemp: async (...args: Parameters<typeof fs.mkdtemp>) => {
    const directory = await fs.mkdtemp(...args);
    observed.directory = String(directory);
    return directory;
  } };
});
vi.mock("node:child_process", async (importOriginal) => {
  const cp = await importOriginal<typeof import("node:child_process")>();
  return { ...cp, spawn: (_command: string, _args: string[], options: Parameters<typeof cp.spawn>[2]) => {
    // Launch a local inert stand-in; no Codex CLI, network, or model API is called.
    const child = cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    observed.child = child;
    observed.closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    return child;
  } };
});
const { CodexDecisionWorker } = await import("./codexDecisionWorker.js");

it.skipIf(process.platform === "win32")("terminates a real stalled local subprocess and removes the real schema directory", async () => {
  const worker = new CodexDecisionWorker({ ...config, codex: { ...config.codex, timeoutMs: 250, useCliFallback: true } }, { warn: vi.fn() } as unknown as Logger);
  const context = { market_snapshot: { symbol: "BTCUSDT" }, trigger: {}, context_summary: {} } as DecisionContext;
  try {
    await expect(worker.decide(context)).rejects.toThrow("timed out after 250ms");
    await expect(observed.closed).resolves.toEqual({ code: null, signal: "SIGKILL" });
    await expect(access(observed.directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (observed.child && observed.child.signalCode === null) observed.child.kill("SIGKILL");
  }
});
