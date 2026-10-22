import { describe, expect, it } from "vitest";

import { readBacktestOptions } from "./backtestOptions.js";

describe("readBacktestOptions", () => {
  it("preserves the default range and configured paper balance", () => {
    expect(readBacktestOptions({}, 12_000)).toEqual({ days: 90, initialBalance: 12_000 });
  });

  it("accepts positive fractional days and monetary overrides", () => {
    expect(
      readBacktestOptions({ BACKTEST_DAYS: "1.5", BACKTEST_INITIAL_BALANCE: "2500.75" }, 10_000)
    ).toEqual({ days: 1.5, initialBalance: 2500.75 });
  });

  for (const variable of ["BACKTEST_DAYS", "BACKTEST_INITIAL_BALANCE"] as const) {
    it.each(["not-a-number", "NaN", "Infinity", "-Infinity", "0", "-2", "", "   "])(
      `rejects ${variable}=%j with a named error`,
      (value) => {
        expect(() => readBacktestOptions({ [variable]: value }, 10_000)).toThrow(
          `${variable} must be a finite number greater than zero`
        );
      }
    );
  }
});
