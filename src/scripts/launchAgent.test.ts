import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
const modulePath = "../../scripts/run-launch-agent.mjs";
const { startLaunchAgent, runCommand } = await import(modulePath);
afterEach(() => vi.restoreAllMocks());

const ready = () => vi.fn().mockImplementation(async (_cmd, args) => args.includes("ping") ? "PONG" : "");
describe("launch-agent readiness", () => {
  it("waits for services, verifies them, builds current source then starts the foreground app", async () => {
    const run = ready(); await startLaunchAgent("/repo with spaces", run);
    expect(run.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ["docker", ["compose", "up", "--detach", "--wait", "--wait-timeout", "60", "postgres", "redis"]],
      ["docker", ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "postgres", "-d", "trader"]],
      ["docker", ["compose", "exec", "-T", "redis", "redis-cli", "--raw", "ping"]],
      ["npm", ["run", "build"]],
      ["/usr/bin/caffeinate", ["-im", process.execPath, "dist/index.js"]]
    ]);
    for (const call of run.mock.calls) expect(call[2].cwd).toBe("/repo with spaces");
    expect(run.mock.calls.slice(0, 4).every(call => call[2].timeoutMs > 0)).toBe(true);
    expect(run.mock.calls[4]![2].timeoutMs).toBeUndefined();
  });

  it.each([0, 1, 2, 3])("does not start the app if preflight stage %i fails", async stage => {
    const run = ready(); for (let i = 0; i < stage; i++) run.mockResolvedValueOnce(i === 2 ? "PONG" : "");
    run.mockRejectedValueOnce(new Error("fixture readiness failure"));
    await expect(startLaunchAgent("/repo", run)).rejects.toThrow();
    expect(run.mock.calls.some(call => call[0] === "/usr/bin/caffeinate")).toBe(false);
    expect(run).toHaveBeenCalledTimes(stage + 1);
  });

  it("requires a positive Redis response before the build", async () => {
    const run = vi.fn().mockResolvedValue("LOADING");
    await expect(startLaunchAgent("/repo", run)).rejects.toThrow("PONG");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("renders the foreground wrapper without automatic restart loops", () => {
    const template = readFileSync(new URL("../../ops/launchd/com.btc-codex-trading-lab.plist.template", import.meta.url), "utf8");
    expect(template).toContain("__WORKDIR__/scripts/run-launch-agent.mjs");
    expect(template).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
    expect(template).toContain("__PATH__");
  });

  it("actually terminates a stalled local process on its command deadline", async () => {
    await expect(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: process.cwd(), timeoutMs: 100
    })).rejects.toThrow("stopped before readiness or completion");
  });

  it("propagates nonzero command results", async () => {
    await expect(runCommand(process.execPath, ["-e", "process.exit(7)"], { cwd: process.cwd(), timeoutMs: 1000 }))
      .rejects.toThrow("exited with 7");
  });
});
