import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { estimateSlippagePrice } from "./lib/math.js";

const require = createRequire(import.meta.url);
const script = ts.transpileModule(readFileSync(new URL("./config.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;
function loadConfig(env: Record<string, string>): AppConfig {
  const exports = {} as { config: AppConfig };
  runInNewContext(script, { exports, URL, process: { env }, require: (id: string) => {
    if (id === "dotenv/config") return {};
    if (id === "zod") return require(id);
    throw new Error(`Unexpected config dependency: ${id}`);
  } });
  return exports.config;
}

const numericKeys = ["APP_PORT", "RISK_PER_TRADE", "MAX_LEVERAGE", "MAX_DAILY_LOSS", "MAX_WEEKLY_DRAWDOWN", "MAX_OPEN_POSITIONS", "COOLDOWN_MINUTES", "MIN_RISK_REWARD", "SLIPPAGE_BPS", "TAKER_FEE_BPS", "PAPER_STARTING_BALANCE", "CODEX_DECISION_TIMEOUT_MS"];

describe("finite runtime numeric configuration", () => {
  it.each(numericKeys)("rejects nonfinite and malformed values for %s", (key) => {
    for (const value of ["Infinity", "-Infinity", "1e309", "NaN", "not-a-number"]) {
      expect(() => loadConfig({ [key]: value }), `${key}=${value}`).toThrow(key);
    }
  });
  it("preserves defaults", () => {
    const config = loadConfig({});
    expect(config.riskPolicy).toEqual({ riskPerTrade: 0.005, maxLeverage: 3, maxDailyLoss: 0.02, maxWeeklyDrawdown: 0.05, maxOpenPositions: 1, cooldownMinutes: 60, minRiskReward: 1.5 });
    expect(config.paperStartingBalance).toBe(10000);
    expect(config.port).toBe(3000);
    expect(config.codex.timeoutMs).toBe(45000);
  });
  it("accepts finite overrides, including zero fees and slippage", () => {
    const config = loadConfig({ RISK_PER_TRADE: "0.01", MAX_LEVERAGE: "5", MAX_DAILY_LOSS: "0.1", MAX_WEEKLY_DRAWDOWN: "0.2", MAX_OPEN_POSITIONS: "2", COOLDOWN_MINUTES: "30", MIN_RISK_REWARD: "2", SLIPPAGE_BPS: "0", TAKER_FEE_BPS: "0", PAPER_STARTING_BALANCE: "25000", APP_PORT: "4000", CODEX_DECISION_TIMEOUT_MS: "10000" });
    expect(config.riskPolicy).toEqual({ riskPerTrade: 0.01, maxLeverage: 5, maxDailyLoss: 0.1, maxWeeklyDrawdown: 0.2, maxOpenPositions: 2, cooldownMinutes: 30, minRiskReward: 2 });
    expect([config.slippageBps, config.takerFeeBps, config.paperStartingBalance, config.port, config.codex.timeoutMs]).toEqual([0, 0, 25000, 4000, 10000]);
  });
});

describe("runtime platform configuration ranges", () => {
  it.each(["65536", "1000000", String(Number.MAX_SAFE_INTEGER)])(
    "rejects APP_PORT=%s before the server attempts to listen", (APP_PORT) => {
      expect(() => loadConfig({ APP_PORT })).toThrow("APP_PORT");
    }
  );
  it.each(["0", "-1", "3300.5"])("preserves the invalid port rejection for %s", (APP_PORT) => {
    expect(() => loadConfig({ APP_PORT })).toThrow("APP_PORT");
  });
  it.each(["1", "3300", "65535"])("accepts the usable port %s", (APP_PORT) => {
    expect(loadConfig({ APP_PORT }).port).toBe(Number(APP_PORT));
  });
  it.each(["2147483648", "4294967295", String(Number.MAX_SAFE_INTEGER)])(
    "rejects CODEX_DECISION_TIMEOUT_MS=%s instead of overflowing the timer", (CODEX_DECISION_TIMEOUT_MS) => {
      expect(() => loadConfig({ CODEX_DECISION_TIMEOUT_MS })).toThrow("CODEX_DECISION_TIMEOUT_MS");
    }
  );
  it.each(["1", "45000", "2147483647"])("accepts the timer duration %s", (CODEX_DECISION_TIMEOUT_MS) => {
    expect(loadConfig({ CODEX_DECISION_TIMEOUT_MS }).codex.timeoutMs).toBe(Number(CODEX_DECISION_TIMEOUT_MS));
  });
});

describe("paper slippage configuration range", () => {
  it.each(["10000", "10001", String(Number.MAX_VALUE)])(
    "rejects SLIPPAGE_BPS=%s before SELL fills become nonpositive", (SLIPPAGE_BPS) => {
      expect(() => loadConfig({ SLIPPAGE_BPS })).toThrow("SLIPPAGE_BPS");
      expect(() => loadConfig({ SLIPPAGE_BPS })).toThrow("must be less than 10000 basis points");
    }
  );
  it("preserves rejection of negative slippage", () => {
    expect(() => loadConfig({ SLIPPAGE_BPS: "-1" })).toThrow("SLIPPAGE_BPS");
  });
  it.each(["0", "3", "9999.999999"])("preserves valid SLIPPAGE_BPS=%s", (SLIPPAGE_BPS) => {
    const { slippageBps } = loadConfig({ SLIPPAGE_BPS });
    expect(slippageBps).toBe(Number(SLIPPAGE_BPS));
    expect(estimateSlippagePrice(100, slippageBps, "SELL")).toBeGreaterThan(0);
    expect(estimateSlippagePrice(100, slippageBps, "BUY")).toBeGreaterThan(0);
  });
});
