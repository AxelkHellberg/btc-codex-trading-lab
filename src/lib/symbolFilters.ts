import type { SymbolFilters } from "../domain/types.js";

/** Required entry rules. Optional limits must also be valid when supplied. */
export const exchangeFilterErrors = (filters: SymbolFilters | undefined): string[] => {
  if (!filters) return ["exchange filters are missing"];
  const errors: string[] = [];
  for (const field of ["tickSize", "stepSize", "minQty"] as const) {
    if (!Number.isFinite(filters[field]) || filters[field] <= 0) errors.push(`exchange filter ${field} must be finite and positive`);
  }
  if (filters.maxQty !== undefined && (!Number.isFinite(filters.maxQty) || filters.maxQty < filters.minQty || filters.maxQty <= 0)) {
    errors.push("exchange filter maxQty is invalid");
  }
  if (filters.minNotional !== undefined && (!Number.isFinite(filters.minNotional) || filters.minNotional <= 0)) {
    errors.push("exchange filter minNotional must be finite and positive");
  }
  if (filters.marketLotSize) {
    const rule = filters.marketLotSize;
    if (!Number.isFinite(rule.minQty) || rule.minQty < 0 || !Number.isFinite(rule.maxQty) ||
        rule.maxQty <= 0 || rule.maxQty < rule.minQty || !Number.isFinite(rule.stepSize) || rule.stepSize <= 0) {
      errors.push("exchange filter MARKET_LOT_SIZE is invalid");
    }
  }
  return errors;
};
