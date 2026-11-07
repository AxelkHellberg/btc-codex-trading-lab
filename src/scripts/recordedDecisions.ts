import { readFile } from "node:fs/promises";
import { z } from "zod";
import { StrategySignalSchema } from "../domain/schemas.js";
import type { StrategySignal } from "../domain/types.js";

const recordingSchema = z.array(z.object({
  timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  signal: StrategySignalSchema.strict()
}).strict());

export function parseRecordedDecisions(value: unknown): Map<number, StrategySignal> {
  const rows = recordingSchema.parse(value);
  const decisions = new Map<number, StrategySignal>();
  let previous = -1;
  for (const row of rows) {
    if (row.timestamp <= previous) throw new Error("Recorded decisions must have strictly increasing timestamps");
    previous = row.timestamp;
    decisions.set(row.timestamp, { ...row.signal, invalidation_price: row.signal.invalidation_price ?? undefined });
  }
  return decisions;
}

export async function loadRecordedDecisions(path: string): Promise<Map<number, StrategySignal>> {
  return parseRecordedDecisions(JSON.parse(await readFile(path, "utf8")));
}
