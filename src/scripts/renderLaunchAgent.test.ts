import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const renderer = path.join(repository, "scripts/render-launch-agent.mjs");
const template = path.join(repository, "ops/launchd/com.btc-codex-trading-lab.plist.template");
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "launch-agent-paths-"));
  temporary.push(directory);
  return directory;
}

describe("launch-agent plist paths", () => {
  it("renders XML text without treating path characters as replacement syntax", () => {
    const directory = fixture();
    const output = path.join(directory, "agent.plist");
    const values = [
      "com.btc-codex-trading-lab",
      '/opt/Node & tools|<current>\\bin/"node"',
      "/repos/research & development|<btc>/__NODE_BIN__",
      "/users/A&B <user>\rname",
      "/logs/out & <stdout>|\\.log",
      "/logs/err & <stderr>|\\.log"
    ];
    const result = spawnSync(process.execPath, [renderer, template, output, ...values], { encoding: "utf8", timeout: 5_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const plist = readFileSync(output, "utf8");
    expect(plist).toContain('<string>/opt/Node &amp; tools|&lt;current&gt;\\bin/"node"</string>');
    expect(plist).toContain("<string>/repos/research &amp; development|&lt;btc&gt;/__NODE_BIN__</string>");
    expect(plist).toContain("<string>/users/A&amp;B &lt;user&gt;&#13;name</string>");
    expect(plist).toContain("<string>/logs/out &amp; &lt;stdout&gt;|\\.log</string>");
    expect(plist).toContain("<string>/logs/err &amp; &lt;stderr&gt;|\\.log</string>");
    expect(plist).toContain("<string>com.btc-codex-trading-lab</string>");
  });

  it("passes the installer's exact paths to its selected Node executable", () => {
    const directory = fixture();
    const root = path.join(directory, "repository & <btc>|with spaces");
    const bin = path.join(directory, "Node & <tools>|with spaces");
    const record = path.join(directory, "node-arguments.json");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    mkdirSync(bin);
    copyFileSync(path.join(repository, "scripts/install-launch-agent.sh"), path.join(root, "scripts/install-launch-agent.sh"));
    // Stub every installer mutation: no build, home-directory write or launchctl call runs.
    writeFileSync(path.join(bin, "node"), `#!${process.execPath}\nrequire("node:fs").writeFileSync(process.env.NODE_RECORD, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
    for (const command of ["npm", "mkdir", "launchctl"]) {
      writeFileSync(path.join(bin, command), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    }
    const result = spawnSync("bash", [path.join(root, "scripts/install-launch-agent.sh")], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_RECORD: record },
      encoding: "utf8", timeout: 5_000
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual([
      path.join(root, "scripts/render-launch-agent.mjs"),
      path.join(root, "ops/launchd/com.btc-codex-trading-lab.plist.template"),
      path.join(process.env.HOME!, "Library/LaunchAgents/com.btc-codex-trading-lab.plist"),
      "com.btc-codex-trading-lab", path.join(bin, "node"), root, process.env.HOME,
      path.join(root, "logs/launchd.out.log"), path.join(root, "logs/launchd.err.log")
    ]);
  });
});
