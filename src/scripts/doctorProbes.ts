import { spawn } from "node:child_process";
import { Client } from "pg";
import { Redis } from "ioredis";
import type { AppConfig } from "../config.js";
import { codexCliInvocation } from "../infra/codexCli.js";

export const PROBE_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 1_000;

export async function withDeadline<T>(work: () => Promise<T>, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Doctor probe timed out")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function runProbeCommand(command: string, args: string[]): Promise<{
  code: number; stdout: string; stderr: string; timedOut: boolean;
}> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: process.env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({ code, stdout, stderr, timedOut });
    };
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* An already-exited child needs no further cleanup. */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      // Kill the entire process group even if the launcher exits before descendants.
      graceTimer = setTimeout(() => { kill("SIGKILL"); finish(124); }, 250);
    }, PROBE_TIMEOUT_MS);
    child.stdout!.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-16_384); });
    child.stderr!.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    child.on("error", error => { stderr = error.message; finish(1); });
    child.on("close", code => { if (!timedOut) finish(code ?? 1); });
  });
}

const httpProbe = async (url: string, checkBody: boolean): Promise<string> => {
  const controller = new AbortController();
  try {
    return await withDeadline(async () => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return "down";
      if (!checkBody) return "ok";
      const payload: unknown = await response.json();
      return typeof payload === "object" && payload !== null && "ok" in payload && payload.ok === true
        && "ts" in payload && typeof payload.ts === "number" && Number.isFinite(payload.ts) ? "ok" : "down";
    });
  } catch { return "down"; }
  finally { controller.abort(); }
};

export async function probeDoctor(config: AppConfig) {
  const postgres = async () => {
    const client = new Client({
      connectionString: config.postgresUrl,
      connectionTimeoutMillis: PROBE_TIMEOUT_MS, query_timeout: PROBE_TIMEOUT_MS
    });
    client.on("error", () => undefined);
    try {
      await withDeadline(async () => { await client.connect(); await client.query("select 1"); });
      return "ok";
    } catch { return "down"; }
    finally { await withDeadline(() => client.end(), CLEANUP_TIMEOUT_MS).catch(() => undefined); }
  };
  const redis = async () => {
    const client = new Redis(config.redisUrl, {
      lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null,
      connectTimeout: PROBE_TIMEOUT_MS, commandTimeout: PROBE_TIMEOUT_MS
    });
    client.on("error", () => undefined);
    try {
      return await withDeadline(async () => { await client.connect(); return await client.ping() === "PONG" ? "ok" : "down"; });
    } catch { return "down"; }
    finally { client.disconnect(); }
  };
  const [pg, redisState, app, binance] = await Promise.all([
    postgres(), redis(), httpProbe(`http://127.0.0.1:${config.port}/healthz`, true),
    httpProbe(`${config.binance.restBaseUrl}/fapi/v1/premiumIndex?symbol=${config.symbol}`, false)
  ]);
  const cli = codexCliInvocation(["login", "status"]);
  const codex = await runProbeCommand(cli.command, cli.args);
  return {
    checks: { app, postgres: pg, redis: redisState, binance, trading_mode: config.tradingMode,
      binance_creds_present: Boolean(config.binance.apiKey && config.binance.apiSecret),
      telegram_present: Boolean(config.telegram.botToken && config.telegram.chatId) },
    codex: { ...codex, stdout: codex.stdout.trim(), stderr: codex.stderr.trim() }
  };
}
