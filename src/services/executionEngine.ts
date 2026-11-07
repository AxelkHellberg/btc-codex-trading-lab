import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type {
  DecisionContext,
  PersistedDecisionRecord,
  RiskEvaluation,
  StrategySignal
} from "../domain/types.js";
import type { TelegramNotifier } from "../infra/notifier/telegramNotifier.js";
import type { PostgresStateStore } from "../infra/store/postgresStateStore.js";
import type { Broker } from "./brokers.js";
import type { TradePersistenceQueue } from "./tradePersistenceQueue.js";
import type { RuntimeState } from "./runtimeState.js";

export class ExecutionEngine {
  public constructor(
    private readonly config: AppConfig,
    private readonly runtime: RuntimeState,
    private readonly store: PostgresStateStore,
    private readonly notifier: TelegramNotifier,
    private readonly broker: Broker,
    private readonly logger: Logger,
    private readonly tradePersistence?: Pick<TradePersistenceQueue, "save">,
    private readonly persistState?: (result: Awaited<ReturnType<Broker["execute"]>>) => Promise<void>
  ) {}

  public async persistDecision(
    context: DecisionContext,
    signal: StrategySignal,
    evaluation: RiskEvaluation
  ): Promise<void> {
    const record: PersistedDecisionRecord = {
      decisionId: randomUUID(),
      approved: evaluation.approved,
      mode: this.config.tradingMode,
      trigger: context.trigger,
      context,
      signal,
      plan: evaluation.executionPlan,
      reasons: evaluation.reasons,
      createdAt: Date.now()
    };
    this.runtime.pushDecision(record);
    await this.store.saveDecision(record);
  }

  public async maybeExecute(
    context: DecisionContext,
    signal: StrategySignal,
    evaluation: RiskEvaluation
  ): Promise<void> {
    await this.persistDecision(context, signal, evaluation);
    if (!evaluation.approved || !evaluation.executionPlan) {
      this.logger.info({ reasons: evaluation.reasons }, "Trade decision rejected by risk engine");
      return;
    }

    const result = await this.broker.execute(evaluation.executionPlan, context);
    await this.handleExecutionResult(result, evaluation.executionPlan.reasoningSummary);
  }

  public async handleExecutionResult(result: Awaited<ReturnType<Broker["execute"]>>, fallbackReasoning?: string): Promise<void> {
    this.runtime.setAccount(result.accountState);
    this.runtime.setPosition(result.positionState);

    const failures: unknown[] = [];
    // Start the independent state write even if the trade audit later fails.
    const stateWrite = this.persistState
      ? Promise.resolve().then(() => this.persistState!(result)).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error })
        )
      : Promise.resolve({ ok: true as const });
    if (result.tradeRecord) {
      this.runtime.upsertTrade(result.tradeRecord);
      try {
        await (this.tradePersistence ? this.tradePersistence.save(result.tradeRecord) : this.store.saveTrade(result.tradeRecord));
      } catch (error) {
        failures.push(error);
        this.logger.error(
          { tradeId: result.tradeId, accepted: result.accepted },
          "Trade audit persistence failed after broker result"
        );
      }
    }

    const tradeAuditFailed = failures.length > 0;
    const stateOutcome = await stateWrite;
    if (!stateOutcome.ok) {
      failures.push(stateOutcome.error);
      this.logger.error({ tradeId: result.tradeId }, "Execution state snapshot persistence failed");
    }

    if (result.accepted) {
      const reasoning =
        (typeof result.tradeRecord?.details === "object" &&
        result.tradeRecord?.details !== null &&
        "reasoning" in result.tradeRecord.details
          ? String((result.tradeRecord.details as { reasoning?: string }).reasoning ?? "")
          : fallbackReasoning) ?? "";
      const persistenceWarning =
        (tradeAuditFailed ? "\nWarning: trade audit persistence failed." : "") +
        (!stateOutcome.ok ? "\nWarning: account/position snapshot persistence failed." : "");
      try {
        await this.notifier.notify(
          `[${this.config.tradingMode}] ${result.message}${reasoning ? `\n${reasoning}` : ""}${persistenceWarning}`
        );
      } catch (error) {
        failures.push(error);
        this.logger.error({ tradeId: result.tradeId }, "Accepted execution notification failed");
      }
    }

    // The broker has already acted. Surface failures without replaying any side effect.
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Execution result persistence and notification failed");
    }
  }

  public async syncBrokerPositionFromMarket(snapshotHandler: (() => Promise<void>) | undefined): Promise<void> {
    if (snapshotHandler) {
      await snapshotHandler();
    }
  }
}
