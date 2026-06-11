import type { PositionDirection, SymbolFilters } from "../domain/types.js";

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

export const roundToStep = (value: number, step: number): number => {
  if (!Number.isFinite(value) || step <= 0) {
    return value;
  }

  const precision = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number((Math.floor(value / step) * step).toFixed(precision));
};

export const roundToTick = (value: number, tick: number): number => {
  if (!Number.isFinite(value) || tick <= 0) {
    return value;
  }

  const precision = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number((Math.round(value / tick) * tick).toFixed(precision));
};

export const roundToTickLong = (value: number, tick: number): number => {
  if (!Number.isFinite(value) || tick <= 0) {
    return value;
  }

  const precision = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number((Math.floor(value / tick) * tick).toFixed(precision));
};

export const roundToTickShort = (value: number, tick: number): number => {
  if (!Number.isFinite(value) || tick <= 0) {
    return value;
  }

  const precision = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number((Math.ceil(value / tick) * tick).toFixed(precision));
};

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