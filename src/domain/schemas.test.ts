import { describe, expect, it } from "vitest";

import { StrategySignalSchema } from "./schemas.js";

const signal = {
  bias: "SHORT",
  confidence: 0.7,
  setup_type: "continuation",
  invalidation_price: 101_000,
  holding_horizon_minutes: 30,
  reasoning_summary: "Price broke below the recent support level."
};

describe("StrategySignalSchema invalidation prices", () => {
  it("rejects numeric overflow in otherwise valid model JSON", () => {
    const modelOutput = JSON.stringify(signal).replace('"invalidation_price":101000', '"invalidation_price":1e999');
    const parsed: unknown = JSON.parse(modelOutput);

    const result = StrategySignalSchema.safeParse(parsed);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(issue => issue.path.join(".") === "invalidation_price")).toBe(true);
    }
  });

  it.each(["LONG", "SHORT", "FLAT", "CLOSE", "REDUCE"])(
    "rejects infinite invalidation prices for %s signals",
    bias => {
      expect(StrategySignalSchema.safeParse({ ...signal, bias, invalidation_price: Infinity }).success).toBe(false);
    }
  );

  it.each([NaN, -Infinity, 0, -1, "101000"])("rejects an invalid price of %s", invalidation_price => {
    expect(StrategySignalSchema.safeParse({ ...signal, invalidation_price }).success).toBe(false);
  });

  it.each([0.00001, 101_000.25, 1e100, Number.MAX_VALUE])(
    "preserves the finite positive price %s",
    invalidation_price => {
      expect(StrategySignalSchema.parse({ ...signal, invalidation_price }).invalidation_price).toBe(invalidation_price);
    }
  );

  it("preserves nullable prices for signals without an invalidation level", () => {
    expect(StrategySignalSchema.parse({ ...signal, bias: "FLAT", invalidation_price: null }).invalidation_price).toBeNull();
  });
});
