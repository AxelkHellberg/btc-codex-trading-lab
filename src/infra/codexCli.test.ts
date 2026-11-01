import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import { codexCliInvocation } from "./codexCli.js";

const require = createRequire(import.meta.url);
afterEach(() => vi.restoreAllMocks());

describe("installed Codex CLI", () => {
  it("resolves independently of the application's current working directory", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/a/different/working-directory");
    const invocation = codexCliInvocation(["login", "status"]);
    expect(invocation).toEqual({
      command: process.execPath,
      args: [require.resolve("@openai/codex/bin/codex.js"), "login", "status"]
    });
  });

  it("runs the pinned package's offline version command from a clean install", () => {
    const cli = codexCliInvocation(["--version"]);
    const result = spawnSync(cli.command, cli.args, { encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("codex-cli 0.118.0");
  });
});
