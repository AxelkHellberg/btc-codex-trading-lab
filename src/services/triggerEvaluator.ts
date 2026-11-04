import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import type { EvaluationTrigger } from "../domain/types.js";
import type { TelegramNotifier } from "../infra/notifier/telegramNotifier.js";
import type { RedisHotStore } from "../infra/store/redisHotStore.js";
import type { CodexDecisionWorker } from "./codexDecisionWorker.js";
import type { ExecutionEngine } from "./executionEngine.js";
import type { RiskEngine } from "./riskEngine.js";
import type { RuntimeState } from "./runtimeState.js";
import type { StrategyPlanner } from "./strategyPlanner.js";

export interface TriggerEvaluationResult {
  status: "completed" | "busy" | "no_market" | "failed";
}
interface Dependencies {
  runtime: Pick<RuntimeState, "buildDecisionContext">;
  hotStore: Pick<RedisHotStore, "acquireLock" | "releaseLock" | "setJson">;
  decisionWorker: Pick<CodexDecisionWorker, "decide">;
  planner: Pick<StrategyPlanner, "plan">;
  riskEngine: Pick<RiskEngine, "evaluate">;
  executionEngine: Pick<ExecutionEngine, "maybeExecute">;
  notifier: Pick<TelegramNotifier, "notify">;
  logger: Logger;
  riskPolicy: AppConfig["riskPolicy"];
}

// Completion means the evaluation ran, including a valid risk rejection. It does not
// promise that an order was approved or placed.
export function createTriggerEvaluator(deps: Dependencies) {
  return async (trigger: EvaluationTrigger): Promise<TriggerEvaluationResult> => {
    const lockToken = `${process.pid}-${trigger.reason}-${trigger.triggeredAt}`;
    let acquired = false;
    let result: TriggerEvaluationResult = { status: "failed" };
    try {
      acquired = await deps.hotStore.acquireLock("decision-loop", lockToken, 55_000);
      if (!acquired) return { status: "busy" };
      const context = deps.runtime.buildDecisionContext(trigger, deps.riskPolicy);
      if (!context) {
        result = { status: "no_market" };
      } else {
        await deps.hotStore.setJson("latest:context", context, 300);
        const signal = await deps.decisionWorker.decide(context);
        const planning = deps.planner.plan(context, signal);
        const evaluation = deps.riskEngine.evaluate(context, planning);
        await deps.executionEngine.maybeExecute(context, signal, evaluation);
        result = { status: "completed" };
      }
    } catch (error) {
      deps.logger.error({ error, trigger }, "Decision loop failed");
      try {
        await deps.notifier.notify(`Decision loop failed: ${String(error)}`);
      } catch (notificationError) {
        deps.logger.error({ error: notificationError }, "Decision failure notification failed");
      }
    } finally {
      if (acquired) {
        try {
          await deps.hotStore.releaseLock("decision-loop", lockToken);
        } catch (error) {
          deps.logger.error({ error, trigger }, "Decision loop lock release failed");
          result = { status: "failed" };
        }
      }
    }
    return result;
  };
}
