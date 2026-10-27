import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function bootstrap(lockfile: boolean, installFails = false, existingEnv = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));
  temporary.push(directory);
  const root = path.join(directory, "repository with spaces");
  const bin = path.join(directory, "bin");
  const trace = path.join(directory, "commands");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  mkdirSync(bin);
  copyFileSync(path.join(repository, "scripts/bootstrap.sh"), path.join(root, "scripts/bootstrap.sh"));
  writeFileSync(path.join(root, ".env.example"), "TRADING_MODE=paper\n");
  if (existingEnv) writeFileSync(path.join(root, ".env"), "EXISTING=keep\n");
  if (lockfile) writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(bin, "npm"), '#!/usr/bin/env bash\nprintf "npm:%s:%s\\n" "$PWD" "$*" >> "$TRACE"\nexit "$INSTALL_CODE"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, "docker"), '#!/usr/bin/env bash\nprintf "docker:%s\\n" "$*" >> "$TRACE"\n', { mode: 0o755 });
  const result = spawnSync("bash", [path.join(root, "scripts/bootstrap.sh")], {
    cwd: directory,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRACE: trace, INSTALL_CODE: installFails ? "23" : "0" },
    encoding: "utf8",
    timeout: 5_000
  });
  return { result, root, commands: readFileSync(trace, "utf8") };
}

describe("bootstrap dependency installation", () => {
  it("uses npm ci with the committed lockfile and preserves existing environment settings", () => {
    const { result, root, commands } = bootstrap(true, false, true);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(commands.split("\n")[0]).toBe(`npm:${root}:ci`);
    expect(commands).toContain("docker:compose up -d postgres redis");
    expect(readFileSync(path.join(root, "package-lock.json"), "utf8")).toBe('{"lockfileVersion":3}\n');
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("EXISTING=keep\n");
  });

  it("falls back to npm install when no lockfile exists and creates the initial environment", () => {
    const { result, root, commands } = bootstrap(false);
    expect(result.status).toBe(0);
    expect(commands.split("\n")[0]).toBe(`npm:${root}:install`);
    expect(existsSync(path.join(root, "package-lock.json"))).toBe(false);
    expect(readFileSync(path.join(root, ".env"), "utf8")).toBe("TRADING_MODE=paper\n");
  });

  it("stops before Docker when the deterministic install fails", () => {
    const { result, commands } = bootstrap(true, true);
    expect(result.status).toBe(23);
    expect(commands.split("\n")[0]).toMatch(/:ci$/);
    expect(commands).not.toContain("docker:");
  });
});
