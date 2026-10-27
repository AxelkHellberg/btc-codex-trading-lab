import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtures: string[] = [];
const live = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function fixture(mode: string, dotenvPort = false) {
  const directory = mkdtempSync(path.join(tmpdir(), "daemon-startup-"));
  fixtures.push(directory);
  for (const name of ["scripts", "dist", "bin"]) mkdirSync(path.join(directory, name));
  copyFileSync(path.join(root, "scripts/run-daemon.sh"), path.join(directory, "scripts/run-daemon.sh"));
  if (existsSync(path.join(root, "scripts/wait-for-daemon.mjs"))) {
    copyFileSync(path.join(root, "scripts/wait-for-daemon.mjs"), path.join(directory, "scripts/wait-for-daemon.mjs"));
  }
  symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
  for (const command of ["npm", "docker"]) {
    writeFileSync(path.join(directory, "bin", command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  writeFileSync(path.join(directory, "bin/caffeinate"),
    '#!/bin/sh\necho $$ > spawned-helper.pid\nexec sleep 120\n', { mode: 0o755 });
  const portServer = createServer();
  await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>((resolve) => portServer.close(() => resolve()));
  writeFileSync(path.join(directory, "dist/index.js"), `
    require('node:fs').writeFileSync('spawned-app.pid', String(process.pid));
    if (${JSON.stringify(mode)} === 'exit') process.exit(2);
    const port = ${port};
    if (${JSON.stringify(mode)} === 'resist-term') process.on('SIGTERM', () => {});
    if (['hang', 'resist-term'].includes(${JSON.stringify(mode)})) setInterval(() => {}, 1000);
    else require('node:http').createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (${JSON.stringify(mode)} === 'stalled-body') { response.write('{'); return; }
      response.end(JSON.stringify({ok: ${mode !== "invalid"}, ts: Date.now(), pid: ${mode === "wrong-pid" ? "process.pid + 1" : "process.pid"}}));
    }).listen(port, '127.0.0.1');
  `);
  if (dotenvPort) writeFileSync(path.join(directory, ".env"), `APP_PORT=${port}\n`);
  const env = { ...process.env, PATH: `${directory}/bin:${process.env.PATH}`, DAEMON_STARTUP_TIMEOUT_SECONDS: "1" };
  if (dotenvPort) delete env.APP_PORT;
  else Object.assign(env, { APP_PORT: String(port) });
  return { directory, env };
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    for (const file of ["spawned-app.pid", "spawned-helper.pid"]) {
      if (existsSync(path.join(directory, file))) {
        try { process.kill(Number(readFileSync(path.join(directory, file), "utf8")), "SIGKILL"); } catch {}
      }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("daemon launch readiness", () => {
  it.each([false, true])("waits for the matching healthy process (dotenv port: %s)", async (dotenvPort) => {
    const { directory, env } = await fixture("ready", dotenvPort);
    const result = spawnSync("bash", ["scripts/run-daemon.sh"], { cwd: directory, env, encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("app pid:");
    const pid = Number(readFileSync(path.join(directory, "run/app.pid"), "utf8"));
    expect(live(pid)).toBe(true);
    // Success must mean the exact child already serves the expected payload.
    const body = JSON.parse(execFileSync(process.execPath, ["-e", `fetch('http://127.0.0.1:${dotenvPort ? readFileSync(path.join(directory, '.env'), 'utf8').trim().split('=')[1] : env.APP_PORT}/healthz').then(r=>r.text()).then(console.log)`], { encoding: "utf8", timeout: 3000 }));
    expect(body).toMatchObject({ ok: true, pid });
  });

  it.each(["exit", "hang", "invalid", "wrong-pid", "stalled-body", "resist-term"])("fails and cleans up a %s startup", async (mode) => {
    const { directory, env } = await fixture(mode);
    const result = spawnSync("bash", ["scripts/run-daemon.sh"], { cwd: directory, env, encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("logs/app.log");
    expect(result.stdout).not.toContain("app pid:");
    expect(existsSync(path.join(directory, "run/app.pid"))).toBe(false);
    expect(existsSync(path.join(directory, "run/caffeinate.pid"))).toBe(false);
    for (const file of ["spawned-app.pid", "spawned-helper.pid"]) {
      if (existsSync(path.join(directory, file))) {
        expect(live(Number(readFileSync(path.join(directory, file), "utf8")))).toBe(false);
      }
    }
  });

  it("rechecks an existing daemon without stopping it after a failed check", async () => {
    const { directory, env } = await fixture("ready");
    const first = spawnSync("bash", ["scripts/run-daemon.sh"], { cwd: directory, env, encoding: "utf8", timeout: 10_000 });
    expect(first.status, first.stderr).toBe(0);
    const pidText = readFileSync(path.join(directory, "run/app.pid"), "utf8");
    const again = spawnSync("bash", ["scripts/run-daemon.sh"], { cwd: directory, env, encoding: "utf8", timeout: 10_000 });
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain("app already running");
    const failed = spawnSync("bash", ["scripts/run-daemon.sh"], {
      cwd: directory, env: { ...env, APP_PORT: "invalid" }, encoding: "utf8", timeout: 10_000
    });
    expect(failed.status).not.toBe(0);
    expect(readFileSync(path.join(directory, "run/app.pid"), "utf8")).toBe(pidText);
    expect(live(Number(pidText))).toBe(true);
  });
});
