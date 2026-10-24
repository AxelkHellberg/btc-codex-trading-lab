import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";

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
  });
  it("accepts finite overrides, including zero fees and slippage", () => {
    const config = loadConfig({ RISK_PER_TRADE: "0.01", MAX_LEVERAGE: "5", MAX_DAILY_LOSS: "0.1", MAX_WEEKLY_DRAWDOWN: "0.2", MAX_OPEN_POSITIONS: "2", COOLDOWN_MINUTES: "30", MIN_RISK_REWARD: "2", SLIPPAGE_BPS: "0", TAKER_FEE_BPS: "0", PAPER_STARTING_BALANCE: "25000", APP_PORT: "4000", CODEX_DECISION_TIMEOUT_MS: "10000" });
    expect(config.riskPolicy).toEqual({ riskPerTrade: 0.01, maxLeverage: 5, maxDailyLoss: 0.1, maxWeeklyDrawdown: 0.2, maxOpenPositions: 2, cooldownMinutes: 30, minRiskReward: 2 });
    expect([config.slippageBps, config.takerFeeBps, config.paperStartingBalance, config.port, config.codex.timeoutMs]).toEqual([0, 0, 25000, 4000, 10000]);
  });
});
