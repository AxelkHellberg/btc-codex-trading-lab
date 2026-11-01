import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@openai/codex-sdk", () => ({ Codex: class { startThread() { return {}; } } }));
import { CodexDecisionWorker } from "./codexDecisionWorker.js";

const require = createRequire(import.meta.url);

describe("CLI fallback process contract", () => {
  it("starts the declared local CLI with the active Node and preserves exec arguments", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(),
      stdin: { write: vi.fn(), end: () => queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"ok":true}' } }) + "\n");
        child.emit("close", 0);
      }) }
    });
    mocks.spawn.mockReturnValue(child);
    const worker = new CodexDecisionWorker({ codex: { model: "offline-fixture" } } as AppConfig, {} as Logger);
    const result = await (worker as unknown as { runViaCli(prompt: string): Promise<unknown> }).runViaCli("fixture prompt");
    expect(result).toEqual({ ok: true });
    const [command, args] = mocks.spawn.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(args.slice(0, 5)).toEqual([require.resolve("@openai/codex/bin/codex.js"), "exec", "--experimental-json", "--model", "offline-fixture"]);
    expect(args).toContain("--output-schema");
    expect(child.stdin.write).toHaveBeenCalledWith("fixture prompt");
  });
});
