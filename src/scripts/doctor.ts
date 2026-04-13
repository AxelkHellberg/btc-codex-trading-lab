import { spawn } from "node:child_process";

import { Redis } from "ioredis";
import { Client } from "pg";

import { config } from "../config.js";
import { logger } from "../logger.js";

const run = async (command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

const main = async (): Promise<void> => {
  const pg = new Client({ connectionString: config.postgresUrl });
  const redis = new Redis(config.redisUrl);
  let postgres = "down";
  let redisState = "down";
  let app = "down";
  let binance = "down";

  try {
    await pg.connect();
    await pg.query("select 1");
    postgres = "ok";
  } catch {
    postgres = "down";
  } finally {
    await pg.end().catch(() => undefined);
  }

  try {
    redisState = (await redis.ping()) === "PONG" ? "ok" : "down";
  } catch {
    redisState = "down";
  } finally {
    await redis.quit().catch(() => undefined);
  }

  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/healthz`);
    const payload = (await response.json()) as { ok?: boolean };
    app = payload.ok ? "ok" : "down";
  } catch {
    app = "down";
  }

  try {
    const response = await fetch(`${config.binance.restBaseUrl}/fapi/v1/premiumIndex?symbol=${config.symbol}`);
    binance = response.ok ? "ok" : "down";
  } catch {
    binance = "down";
  }

  const checks = {
    app,
    postgres,
    redis: redisState,
    binance,
    trading_mode: config.tradingMode,
    binance_creds_present: Boolean(config.binance.apiKey && config.binance.apiSecret),
    telegram_present: Boolean(config.telegram.botToken && config.telegram.chatId)
  };

  const codexStatus = await run("npx", ["@openai/codex", "login", "status"]);
  logger.info(
    {
      checks,
      codex: {
        code: codexStatus.code,
        stdout: codexStatus.stdout.trim(),
        stderr: codexStatus.stderr.trim()
      }
    },
    "Runtime doctor"
  );
};

void main().catch((error) => {
  logger.error({ error }, "Doctor failed");
  process.exit(1);
});
