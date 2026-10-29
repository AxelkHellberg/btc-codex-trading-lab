import { describe, expect, it } from "vitest";

import { normalizeQuantity, roundProtectivePrice, roundToStep, roundToTick } from "./math.js";

describe("exchange increment rounding", () => {
  it.each([
    ["long", 100.06, 0.1, 100],
    ["short", 100.14, 0.1, 100.2],
    ["long", 0.3, 0.1, 0.3],
    ["short", 0.3, 0.1, 0.3],
    ["long", 12.2, 0.125, 12.125],
    ["short", 12.2, 0.125, 12.25],
    ["long", 3.74e-120, 1.25e-120, 2.5e-120],
    ["short", 3.74e-120, 1.25e-120, 3.75e-120]
  ] as const)("keeps %s protective price %s outward on increment %s", (side, value, tick, expected) => {
    const rounded = roundProtectivePrice(value, tick, side);
    expect(rounded).toBe(expected);
    expect(roundProtectivePrice(rounded, tick, side)).toBe(expected);
    expect(side === "long" ? rounded <= value : rounded >= value).toBe(true);
  });

  it.each([
    [1.25, 0.25, 1.25],
    [1.74, 0.25, 1.5],
    [12.125, 0.125, 12.125],
    [12.24, 0.125, 12.125],
    [7.49, 2.5, 5],
    [0.3, 0.1, 0.3],
    [0.009, 0.003, 0.009],
    [0.000000375, 1.25e-7, 0.000000375],
    [0.000000374, 1.25e-7, 0.00000025],
    [-1.26, 0.25, -1.5]
  ])("floors quantity %s to increment %s", (value, increment, expected) => {
    expect(roundToStep(value, increment)).toBe(expected);
    expect(roundToStep(expected, increment)).toBe(expected);
  });

  it.each([
    [1.25, 0.25, 1.25],
    [1.74, 0.25, 1.75],
    [12.125, 0.125, 12.125],
    [12.2, 0.125, 12.25],
    [7.49, 2.5, 7.5],
    [0.3, 0.1, 0.3],
    [0.0000003125, 1.25e-7, 0.000000375],
    [1.125, 0.25, 1.25],
    [-1.125, 0.25, -1],
    [100000.16, 0.1, 100000.2]
  ])("rounds price %s to nearest increment %s", (value, increment, expected) => {
    expect(roundToTick(value, increment)).toBe(expected);
    expect(roundToTick(expected, increment)).toBe(expected);
  });

  it("preserves small increments without a fixed decimal-place limit", () => {
    expect(roundToStep(3.75e-120, 1.25e-120)).toBe(3.75e-120);
    expect(roundToTick(3.75e-120, 1.25e-120)).toBe(3.75e-120);
  });

  it.each([0, -1, NaN, Infinity])("leaves invalid increment %s unchanged", (increment) => {
    expect(roundToStep(1.23, increment)).toBe(1.23);
    expect(roundToTick(1.23, increment)).toBe(1.23);
  });

  it("keeps quantity normalization on the exchange grid and enforces minQty", () => {
    const filters = { stepSize: 0.125, tickSize: 0.25, minQty: 0.25 };
    expect(normalizeQuantity(1.37, filters)).toBe(1.25);
    expect(normalizeQuantity(0.24, filters)).toBe(0);
  });
});
