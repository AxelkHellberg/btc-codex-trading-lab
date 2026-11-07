import type { ExecutionResult } from "../domain/types.js";
import type { PostgresStateStore } from "../infra/store/postgresStateStore.js";
import type { RedisHotStore } from "../infra/store/redisHotStore.js";

export async function persistExecutionSnapshots(
  store: Pick<PostgresStateStore, "saveSnapshot">,
  hotStore: Pick<RedisHotStore, "setJson">,
  result: Pick<ExecutionResult, "accountState" | "positionState">
): Promise<void> {
  // Each destination must be attempted even if another is unavailable. No
  // exchange operation is retried, and this pair is not a cross-store transaction.
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => store.saveSnapshot("account", result.accountState)),
    Promise.resolve().then(() => store.saveSnapshot("position", result.positionState)),
    Promise.resolve().then(() => hotStore.setJson("latest:account", result.accountState, 300)),
    Promise.resolve().then(() => hotStore.setJson("latest:position", result.positionState, 300))
  ]);
  const errors = outcomes.flatMap(outcome => outcome.status === "rejected" ? [outcome.reason] : []);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Execution snapshots were not fully persisted");
}
