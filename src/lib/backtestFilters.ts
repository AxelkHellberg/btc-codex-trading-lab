import { readFile } from "node:fs/promises";
import { z } from "zod";

import type { SymbolFilters } from "../domain/types.js";

const filtersSchema = z.object({
  tickSize: z.number().finite().positive(),
  stepSize: z.number().finite().positive(),
  minQty: z.number().finite().positive(),
  maxQty: z.number().finite().positive().optional(),
  marketLotSize: z.object({
    minQty: z.number().finite().nonnegative(),
    maxQty: z.number().finite().nonnegative(),
    stepSize: z.number().finite().nonnegative()
  }).strict().optional(),
  minNotional: z.number().finite().nonnegative().optional()
}).strict();
const snapshotSchema = z.object({ symbol: z.string().min(1), filters: filtersSchema }).strict();

/** A fixed snapshot bypasses exchangeInfo; candles are still fetched separately. */
export const loadBacktestFilters = async (
  symbol: string,
  client: { getSymbolFilters(symbol: string): Promise<SymbolFilters | undefined> },
  snapshotFile?: string
): Promise<{ source: string; filters: SymbolFilters }> => {
  if (snapshotFile !== undefined) {
    if (snapshotFile.trim() === "") throw new Error("BACKTEST_FILTERS_FILE must name a JSON file");
    const snapshot = snapshotSchema.parse(JSON.parse(await readFile(snapshotFile, "utf8")));
    if (snapshot.symbol !== symbol) throw new Error(`Filter snapshot symbol must match ${symbol}`);
    return { source: `snapshot:${snapshotFile}`, filters: snapshot.filters };
  }
  const filters = filtersSchema.parse(await client.getSymbolFilters(symbol));
  return { source: "current-exchangeInfo", filters };
};
