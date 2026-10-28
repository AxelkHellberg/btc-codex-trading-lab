import type { PositionDirection, SymbolFilters } from "../domain/types.js";

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

// Work in decimal integer units: log10-based display precision loses digits for
// increments such as 0.125, and floating division can floor 0.3 / 0.1 to 2.
const decimalParts = (value: number): { coefficient: bigint; exponent: number } => {
  const [mantissa = "0", scientificExponent = "0"] = value.toString().split("e");
  const fractionLength = mantissa.split(".")[1]?.length ?? 0;
  return {
    coefficient: BigInt(mantissa.replace(".", "")),
    exponent: Number(scientificExponent) - fractionLength
  };
};

const roundToIncrement = (value: number, increment: number, nearest: boolean): number => {
  if (!Number.isFinite(value) || !Number.isFinite(increment) || increment <= 0) {
    return value;
  }

  const input = decimalParts(value);
  const unit = decimalParts(increment);
  const commonExponent = Math.min(input.exponent, unit.exponent);
  const numerator = input.coefficient * 10n ** BigInt(input.exponent - commonExponent);
  const denominator = unit.coefficient * 10n ** BigInt(unit.exponent - commonExponent);
  let units = numerator / denominator;
  // BigInt division truncates toward zero; quantity rounding requires floor.
  if (numerator < 0n && numerator % denominator !== 0n) {
    units -= 1n;
  }
  if (nearest && (numerator - units * denominator) * 2n >= denominator) {
    units += 1n; // Match Math.round's tie direction, including negative values.
  }
  return Number(`${units * unit.coefficient}e${unit.exponent}`);
};

export const roundToStep = (value: number, step: number): number =>
  roundToIncrement(value, step, false);

export const roundToTick = (value: number, tick: number): number =>
  roundToIncrement(value, tick, true);

export const riskRewardRatio = (entry: number, stop: number, takeProfit: number): number => {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(takeProfit - entry);
  return risk > 0 ? reward / risk : 0;
};

export const signedPnl = (
  side: Exclude<PositionDirection, "flat">,
  entryPrice: number,
  exitPrice: number,
  quantity: number
): number => {
  const direction = side === "long" ? 1 : -1;
  return (exitPrice - entryPrice) * quantity * direction;
};

export const estimateSlippagePrice = (
  price: number,
  slippageBps: number,
  side: "BUY" | "SELL"
): number => {
  const factor = 1 + ((side === "BUY" ? 1 : -1) * slippageBps) / 10_000;
  return price * factor;
};

export const normalizeQuantity = (
  desiredQty: number,
  filters: SymbolFilters | undefined
): number => {
  if (!filters) {
    return desiredQty;
  }

  const rounded = roundToStep(desiredQty, filters.stepSize);
  return rounded < filters.minQty ? 0 : rounded;
};
