import { describe, expect, it } from "vitest";

import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("defaults backtest initial balance to the paper starting balance", () => {
    const config = parseConfig({
      PAPER_STARTING_BALANCE: "25000",
      BACKTEST_DAYS: "30"
    });

    expect(config.paperStartingBalance).toBe(25_000);
    expect(config.backtest.days).toBe(30);
    expect(config.backtest.initialBalance).toBe(25_000);
  });

  it("accepts explicit backtest overrides", () => {
    const config = parseConfig({
      BACKTEST_DAYS: "14",
      BACKTEST_INITIAL_BALANCE: "12000"
    });

    expect(config.backtest.days).toBe(14);
    expect(config.backtest.initialBalance).toBe(12_000);
  });

  it("rejects invalid backtest env values", () => {
    expect(() => parseConfig({ BACKTEST_DAYS: "abc" })).toThrow();
    expect(() => parseConfig({ BACKTEST_DAYS: "0" })).toThrow();
    expect(() => parseConfig({ BACKTEST_INITIAL_BALANCE: "" })).toThrow();
  });
});
