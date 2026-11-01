import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

const launch = (buildStatus = "0", startStatus = "0") => {
  const directory = mkdtempSync(join(tmpdir(), "live-launch-test-"));
  fixtures.push(directory);
  const log = join(directory, "calls");
  writeFileSync(join(directory, "npm"), `#!/usr/bin/env bash
printf '%s|%s|%s\\n' "$PWD" "$TRADING_MODE" "$*" >> "$LAUNCH_TEST_LOG"
if [[ "$*" == "run build" ]]; then exit "$LAUNCH_TEST_BUILD_STATUS"; fi
if [[ "$*" == "start" ]]; then exit "$LAUNCH_TEST_START_STATUS"; fi
exit 93
`, { mode: 0o755 });
  const result = spawnSync("bash", [join(root, "scripts/run-live.sh")], {
    cwd: directory, timeout: 5_000, encoding: "utf8",
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, TRADING_MODE: "paper",
      LAUNCH_TEST_LOG: log, LAUNCH_TEST_BUILD_STATUS: buildStatus, LAUNCH_TEST_START_STATUS: startStatus }
  });
  return { result, calls: readFileSync(log, "utf8").trim().split("\n") };
};

describe("live launcher command contract", () => {
  it("builds once then starts the stable runtime from any working directory", () => {
    const { result, calls } = launch();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(calls).toEqual([`${root}|live|run build`, `${root}|live|start`]);
  });
  it("does not start when the build fails", () => {
    const { result, calls } = launch("17");
    expect(result.status).toBe(17);
    expect(calls).toEqual([`${root}|live|run build`]);
  });
  it("propagates the stable process exit status", () => {
    const { result } = launch("0", "23");
    expect(result.status).toBe(23);
  });
});
