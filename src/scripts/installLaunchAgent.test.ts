import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];

afterEach(() => temporary.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function install(fromRepository: boolean, buildFails = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launch-agent-test-"));
  temporary.push(directory);
  const root = path.join(directory, "repository with spaces");
  const outside = path.join(directory, "another project");
  const userDirectory = path.join(directory, "user");
  const bin = path.join(directory, "bin");
  const trace = path.join(directory, "commands");
  for (const target of [path.join(root, "scripts"), path.join(root, "ops/launchd"), outside, userDirectory, bin]) {
    mkdirSync(target, { recursive: true });
  }
  copyFileSync(path.join(repository, "scripts/install-launch-agent.sh"), path.join(root, "scripts/install-launch-agent.sh"));
  copyFileSync(path.join(repository, "ops/launchd/com.btc-codex-trading-lab.plist.template"), path.join(root, "ops/launchd/com.btc-codex-trading-lab.plist.template"));
  writeFileSync(path.join(bin, "npm"), '#!/usr/bin/env bash\nprintf "npm:%s:%s\\n" "$PWD" "$*" >> "$TRACE"\n[ "$PWD" = "$EXPECTED_ROOT" ] || exit 42\n[ "$*" = "run build" ] || exit 43\nexit "$BUILD_CODE"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, "launchctl"), '#!/usr/bin/env bash\nprintf "launchctl:%s\\n" "$*" >> "$TRACE"\n', { mode: 0o755 });
  const result = spawnSync("bash", [path.join(root, "scripts/install-launch-agent.sh")], {
    cwd: fromRepository ? root : outside,
    env: { ...process.env, HOME: userDirectory, PATH: `${bin}:${process.env.PATH}`, TRACE: trace, EXPECTED_ROOT: root, BUILD_CODE: buildFails ? "23" : "0" },
    encoding: "utf8",
    timeout: 5_000
  });
  return { result, root, userDirectory, commands: readFileSync(trace, "utf8") };
}

describe("launch-agent installation", () => {
  it.each([true, false])("builds its own repository when invoked fromRepository=%s", (fromRepository) => {
    const { result, root, userDirectory, commands } = install(fromRepository);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toContain(`npm:${root}:run build`);
    expect(commands.match(/launchctl:/g)).toHaveLength(4);
    const plist = readFileSync(path.join(userDirectory, "Library/LaunchAgents/com.btc-codex-trading-lab.plist"), "utf8");
    expect(plist).toContain(`<string>${root}</string>`);
    expect(plist).not.toMatch(/__[A-Z_]+__/);
  });

  it("stops before invoking launchctl when the build fails", () => {
    const { result, commands } = install(false, true);
    expect(result.status).toBe(23);
    expect(commands).not.toContain("launchctl:");
  });
});
