import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";

const mocks = vi.hoisted(() => ({
  mkdtemp: vi.fn(), writeFile: vi.fn(), rm: vi.fn(), spawn: vi.fn(),
  run: vi.fn()
}));
vi.mock("node:fs/promises", () => mocks);
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("@openai/codex-sdk", () => ({
  Codex: class { startThread() { return { run: mocks.run }; } }
}));

import { CodexDecisionWorker } from "./codexDecisionWorker.js";

describe("CLI schema cleanup", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.mkdtemp.mockResolvedValue("/tmp/schema-test");
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
  });

  const invoke = () => {
    const worker = new CodexDecisionWorker({ codex: { model: "test" } } as AppConfig, {} as never);
    return (worker as unknown as { runViaCli(prompt: string): Promise<unknown> }).runViaCli("fixture");
  };

  it("removes the created directory when writing the schema fails, without spawning", async () => {
    const failure = new Error("schema write failed");
    mocks.writeFile.mockRejectedValue(failure);
    await expect(invoke()).rejects.toBe(failure);
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith("/tmp/schema-test", { recursive: true, force: true });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("does not attempt cleanup when directory creation itself fails", async () => {
    const failure = new Error("temporary directory unavailable");
    mocks.mkdtemp.mockRejectedValue(failure);
    await expect(invoke()).rejects.toBe(failure);
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.rm).not.toHaveBeenCalled();
  });

  it("also removes the directory when spawning the CLI throws", async () => {
    const failure = new Error("spawn failed");
    mocks.spawn.mockImplementation(() => { throw failure; });
    await expect(invoke()).rejects.toBe(failure);
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith("/tmp/schema-test", { recursive: true, force: true });
  });
});
