import type { SymbolFilters } from "../domain/types.js";

type QuantityRule = { minQty: number; maxQty?: number; stepSize: number };

/** Entry policy: reject a quantity outside either rule; never increase a risk-sized order. */
export const marketEntryQuantityErrors = (quantity: number, filters: SymbolFilters | undefined): string[] => {
  if (!filters) {
    return [];
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return ["market entry quantity must be finite and positive"];
  }
  const reasons: string[] = [];
  const rules: Array<[string, QuantityRule]> = [["LOT_SIZE", filters]];
  if (filters.marketLotSize) {
    rules.push(["MARKET_LOT_SIZE", filters.marketLotSize]);
  }
  for (const [name, rule] of rules) {
    if (!Number.isFinite(rule.minQty) || rule.minQty < 0 ||
        !Number.isFinite(rule.stepSize) || rule.stepSize <= 0 ||
        (rule.maxQty !== undefined && (!Number.isFinite(rule.maxQty) || rule.maxQty <= 0 || rule.maxQty < rule.minQty))) {
      reasons.push(`${name} quantity filter is invalid`);
      continue;
    }
    if (quantity < rule.minQty) {
      reasons.push(`${name} quantity is below minimum`);
    }
    if (rule.maxQty !== undefined && quantity > rule.maxQty) {
      reasons.push(`${name} quantity exceeds maximum`);
    }
    // Futures quantity grids are measured from minQty. Allow only floating-point
    // arithmetic noise in step units; minimum/maximum comparisons remain strict.
    const steps = (quantity - rule.minQty) / rule.stepSize;
    if (!Number.isFinite(steps) || Math.abs(steps) > Number.MAX_SAFE_INTEGER ||
        Math.abs(steps - Math.round(steps)) > 1e-8) {
      reasons.push(`${name} quantity is off step`);
    }
  }
  return reasons;
};
