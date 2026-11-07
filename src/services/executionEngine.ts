import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type {
  DecisionContext,
  ExecutionAttemptRecord,
  PersistedDecisionRecord,
  RiskEvaluation,
  StrategySignal
} from "../domain/types.js";
import type { TelegramNotifier } from "../infra/notifier/telegramNotifier.js";
import type { PostgresStateStore } from "../infra/store/postgresStateStore.js";
import type { Broker } from "./brokers.js";
import type { RuntimeState } from "./runtimeState.js";

export class ExecutionEngine {
  public constructor(
    private readonly config: AppConfig,
    private readonly runtime: RuntimeState,
    private readonly store: PostgresStateStore,
    private readonly notifier: TelegramNotifier,
    private readonly broker: Broker,
    private readonly logger: Logger
  ) {}

  public async persistDecision(
    context: DecisionContext,
    signal: StrategySignal,
    evaluation: RiskEvaluation
  ): Promise<PersistedDecisionRecord> {
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
    return record;
  }

  public async maybeExecute(
    context: DecisionContext,
    signal: StrategySignal,
    evaluation: RiskEvaluation
  ): Promise<void> {
    const decision = await this.persistDecision(context, signal, evaluation);
    if (!evaluation.approved || !evaluation.executionPlan) {
      this.logger.info({ reasons: evaluation.reasons }, "Trade decision rejected by risk engine");
      return;
    }

    const now = Date.now();
    const attempt: ExecutionAttemptRecord = {
      attemptId: randomUUID(), decisionId: decision.decisionId,
      broker: this.broker.name, action: evaluation.executionPlan.action,
      quantity: evaluation.executionPlan.quantity, status: "started",
      phase: "broker.execute", createdAt: now, updatedAt: now
    };
    // Persist intent before entering the broker. A failed audit write blocks entry.
    await this.saveExecutionAttempt(attempt);
    let result: Awaited<ReturnType<Broker["execute"]>>;
    try {
      result = await this.broker.execute(evaluation.executionPlan, context);
    } catch (error) {
      await this.saveExecutionOutcome({ ...attempt, status: "unknown", updatedAt: Date.now() });
      // Raw broker errors can contain remote bodies or signed request details.
      this.logger.error({ attemptId: attempt.attemptId, decisionId: decision.decisionId },
        "Broker execution outcome unknown; reconcile before retrying");
      try {
        await this.notifier.notify(
          `[${this.config.tradingMode}] Broker execution outcome unknown for decision ${decision.decisionId}; reconcile before retrying.`
        );
      } catch {
        this.logger.warn({ attemptId: attempt.attemptId }, "Execution outcome notification failed");
      }
      throw error;
    }
    await this.saveExecutionOutcome({ ...attempt,
      status: result.accepted ? "accepted" : "rejected", updatedAt: Date.now() });
    await this.handleExecutionResult(result, evaluation.executionPlan.reasoningSummary);
  }

  private async saveExecutionAttempt(attempt: ExecutionAttemptRecord): Promise<void> {
    this.runtime.upsertExecutionAttempt(attempt);
    await this.store.saveSnapshot("execution_attempt", attempt);
  }

  private async saveExecutionOutcome(attempt: ExecutionAttemptRecord): Promise<void> {
    try {
      await this.saveExecutionAttempt(attempt);
    } catch {
      // Never replay a broker command or suppress handling of its returned result.
      this.logger.error({ attemptId: attempt.attemptId, status: attempt.status },
        "Execution outcome persistence failed; runtime outcome retained");
    }
  }

  public async handleExecutionResult(result: Awaited<ReturnType<Broker["execute"]>>, fallbackReasoning?: string): Promise<void> {
    this.runtime.setAccount(result.accountState);
    this.runtime.setPosition(result.positionState);

    if (result.tradeRecord) {
      this.runtime.upsertTrade(result.tradeRecord);
      await this.store.saveTrade(result.tradeRecord);
    }

    if (result.accepted) {
      const reasoning =
        (typeof result.tradeRecord?.details === "object" &&
        result.tradeRecord?.details !== null &&
        "reasoning" in result.tradeRecord.details
          ? String((result.tradeRecord.details as { reasoning?: string }).reasoning ?? "")
          : fallbackReasoning) ?? "";
      await this.notifier.notify(
        `[${this.config.tradingMode}] ${result.message}${reasoning ? `\n${reasoning}` : ""}`
      );
    }
  }

  public async syncBrokerPositionFromMarket(snapshotHandler: (() => Promise<void>) | undefined): Promise<void> {
    if (snapshotHandler) {
      await snapshotHandler();
    }
  }
}
