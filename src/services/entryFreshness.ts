import type { ExecutionPlan, MarketSnapshot } from "../domain/types.js";

export const MAX_ENTRY_INPUT_AGE_MS = 90_000;

/** Required entry inputs retain separate observation times across partial refreshes. */
export const entryFreshnessReasons = (snapshot: MarketSnapshot, now: number): string[] =>
  (["mark", "quote", "candle"] as const).flatMap(input => {
    const timestamp = snapshot.inputTimestamps?.[input];
    return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0 &&
      Number.isFinite(now) && timestamp <= now && now - timestamp <= MAX_ENTRY_INPUT_AGE_MS
      ? [] : [`market ${input} input is stale or invalid`];
  });

export const isEntry = (plan: ExecutionPlan | undefined): boolean =>
  plan?.action === "LONG" || plan?.action === "SHORT";
