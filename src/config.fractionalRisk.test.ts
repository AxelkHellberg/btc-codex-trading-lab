import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fields = [
  ["RISK_PER_TRADE", "riskPerTrade", 0.005],
  ["MAX_DAILY_LOSS", "maxDailyLoss", 0.02],
  ["MAX_WEEKLY_DRAWDOWN", "maxWeeklyDrawdown", 0.05]
] as const;

beforeEach(() => {
  vi.resetModules();
  for (const [key] of fields) vi.stubEnv(key, undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe.each(fields)("fractional risk setting %s", (key, field, defaultValue) => {
  it("preserves the documented default", async () => {
    const { config } = await import("./config.js");
    expect(config.riskPolicy[field]).toBe(defaultValue);
  });

  it.each(["0.000001", "0.5", "1"])("accepts a fraction in (0, 1]: %s", async (value) => {
    vi.stubEnv(key, value);
    const { config } = await import("./config.js");
    expect(config.riskPolicy[field]).toBe(Number(value));
  });

  it.each(["1.000001", "2", "100", "0", "-0.1", "Infinity", "-Infinity", "NaN", "invalid", "", " "])(
    "rejects an invalid fraction before service construction: %s",
    async (value) => {
      vi.stubEnv(key, value);
      await expect(import("./config.js")).rejects.toThrow(key);
    }
  );
});
