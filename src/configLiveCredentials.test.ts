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
function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const exports = {} as { config: AppConfig };
  runInNewContext(script, { exports, URL, process: { env }, require: (id: string) => {
    if (id === "dotenv/config") return {};
    if (id === "zod") return require(id);
    throw new Error(`Unexpected config dependency: ${id}`);
  } });
  return exports.config;
}

describe("live-mode credential preflight", () => {
  it("keeps paper mode credential-free", () => {
    const config = loadConfig({});
    expect(config.tradingMode).toBe("paper");
    expect(config.binance.apiKey).toBe("");
    expect(config.binance.apiSecret).toBe("");
  });
  it("accepts nonblank credentials in live mode without changing their bytes", () => {
    const config = loadConfig({ TRADING_MODE: "live", BINANCE_API_KEY: "fixture-key", BINANCE_API_SECRET: "fixture-secret" });
    expect(config.tradingMode).toBe("live");
    expect(config.binance.apiKey).toBe("fixture-key");
    expect(config.binance.apiSecret).toBe("fixture-secret");
  });
  it.each(["BINANCE_API_KEY", "BINANCE_API_SECRET"] as const)("rejects missing, empty and blank %s without exposing its peer", (key) => {
    for (const value of [undefined, "", " ", "\t\n"]) {
      const env = { TRADING_MODE: "live", BINANCE_API_KEY: "fixture-key", BINANCE_API_SECRET: "fixture-secret", [key]: value };
      expect(() => loadConfig(env)).toThrow(key);
      try { loadConfig(env); } catch (error) {
        expect(String(error)).not.toContain("fixture-key");
        expect(String(error)).not.toContain("fixture-secret");
      }
    }
  });
  it("reports both absent live credentials", () => {
    expect(() => loadConfig({ TRADING_MODE: "live" })).toThrow("BINANCE_API_KEY");
    expect(() => loadConfig({ TRADING_MODE: "live" })).toThrow("BINANCE_API_SECRET");
  });
  it("permits blank credentials when paper mode is explicit", () => {
    expect(loadConfig({ TRADING_MODE: "paper", BINANCE_API_KEY: " ", BINANCE_API_SECRET: "\t" }).tradingMode).toBe("paper");
  });
});
