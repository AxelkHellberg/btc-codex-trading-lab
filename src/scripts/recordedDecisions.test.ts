import { expect, it } from "vitest";
import { parseRecordedDecisions } from "./recordedDecisions.js";
const signal = { bias: "CLOSE", confidence: 0.8, setup_type: "protective_exit",
  invalidation_price: null, holding_horizon_minutes: 60, reasoning_summary: "Recorded thesis invalidation." };
it("keeps decisions keyed to their exact candle close and normalizes nullable invalidation", () => {
  const result = parseRecordedDecisions([{ timestamp: 123, signal }]);
  expect(result.get(122)).toBeUndefined(); expect(result.get(124)).toBeUndefined();
  expect(result.get(123)).toEqual({ ...signal, invalidation_price: undefined });
});
it.each([
  [{ timestamp: 123, signal }, { timestamp: 123, signal }],
  [{ timestamp: 124, signal }, { timestamp: 123, signal }]
])("rejects duplicate or out-of-order timestamps", (...rows) => {
  expect(() => parseRecordedDecisions(rows)).toThrow("strictly increasing");
});
it.each([
  { timestamp: -1, signal }, { timestamp: 1.5, signal }, { timestamp: Number.POSITIVE_INFINITY, signal },
  { timestamp: 1, signal: { ...signal, bias: "BUY" } },
  { timestamp: 1, signal: { ...signal, confidence: 2 } },
  { timestamp: 1, signal: { ...signal, extra: "ignored?" } }
])("rejects malformed records before replay", (record) => {
  expect(() => parseRecordedDecisions([record])).toThrow();
});
