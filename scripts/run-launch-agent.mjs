#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function runCommand(command, args, { cwd, timeoutMs, capture = false } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd, env: process.env, detached: true, stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"]
    });
    let output = "";
    let timedOut = false;
    let timer;
    let graceTimer;
    const killGroup = signal => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already exited */ }
    };
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(graceTimer);
      process.off("SIGTERM", terminate); process.off("SIGINT", interrupt);
    };
    const abort = signal => {
      if (timedOut) return;
      timedOut = true;
      killGroup(signal);
      graceTimer = setTimeout(() => {
        killGroup("SIGKILL"); cleanup(); reject(new Error(`${command} stopped before readiness or completion`));
      }, 250);
    };
    const terminate = () => abort("SIGTERM");
    const interrupt = () => abort("SIGINT");
    process.once("SIGTERM", terminate); process.once("SIGINT", interrupt);
    if (timeoutMs) timer = setTimeout(() => abort("SIGTERM"), timeoutMs);
    child.stdout?.on("data", chunk => { output = (output + chunk.toString()).slice(-4096); });
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      if (timedOut) return; // Wait for the descendant-kill grace period.
      cleanup();
      if (code === 0) resolveRun(output.trim());
      else reject(new Error(`${command} exited with ${code ?? "a signal"}`));
    });
  });
}

export async function startLaunchAgent(root, run = runCommand) {
  const options = { cwd: root, timeoutMs: 90_000 };
  console.log("launchd preflight: waiting for local PostgreSQL and Redis");
  await run("docker", ["compose", "up", "--detach", "--wait", "--wait-timeout", "60", "postgres", "redis"], options);
  await run("docker", ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "postgres", "-d", "trader"], { ...options, timeoutMs: 10_000 });
  const pong = await run("docker", ["compose", "exec", "-T", "redis", "redis-cli", "--raw", "ping"], { ...options, timeoutMs: 10_000, capture: true });
  if (pong !== "PONG") throw new Error("Redis did not confirm readiness with PONG");
  console.log("launchd preflight: building current source");
  await run("npm", ["run", "build"], { cwd: root, timeoutMs: 120_000 });
  console.log("launchd preflight complete: starting the app");
  await run("/usr/bin/caffeinate", ["-im", process.execPath, "dist/index.js"], { cwd: root });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  startLaunchAgent(root).catch(error => {
    console.error(`launchd startup failed: ${error.message}. Check Docker Desktop and logs, then use launchctl kickstart to retry.`);
    process.exitCode = 1;
  });
}
