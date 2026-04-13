import type { AppConfig } from "../config.js";
import type { DecisionContext, ExecutionPlan, RiskEvaluation, StrategySignal } from "../domain/types.js";
import { normalizeQuantity, riskRewardRatio } from "../lib/math.js";
import type { PlanningResult } from "./strategyPlanner.js";

export class RiskEngine {
  public constructor(private readonly config: AppConfig) {}

  public evaluate(context: DecisionContext, planning: PlanningResult): RiskEvaluation {
    const reasons = [...planning.reasons];
    const normalizedSignal = planning.normalizedSignal;
    const executionPlan = planning.plan;

    if (!context.risk_state.withinDailyLossLimit) {
      reasons.push("daily loss limit reached");
    }
    if (!context.risk_state.withinWeeklyDrawdown) {
      reasons.push("weekly drawdown exceeded");
    }
    if (context.risk_state.cooldownActive && (normalizedSignal.bias === "LONG" || normalizedSignal.bias === "SHORT")) {
      reasons.push("cooldown active after losses");
    }

    if (normalizedSignal.bias === "FLAT") {
      reasons.push("signal chose FLAT");
      return {
        approved: false,
        reasons: unique(reasons),
        normalizedSignal
      };
    }

    if (!executionPlan) {
      return {
        approved: false,
        reasons: unique(reasons),
        normalizedSignal
      };
    }

    if (normalizedSignal.bias === "CLOSE" || normalizedSignal.bias === "REDUCE") {
      return this.evaluateExit(context, normalizedSignal, executionPlan, reasons);
    }

    return this.evaluateEntry(context, normalizedSignal, executionPlan, reasons);
  }

  private evaluateExit(
    context: DecisionContext,
    normalizedSignal: StrategySignal,
    executionPlan: ExecutionPlan,
    reasons: string[]
  ): RiskEvaluation {
    const existing = context.position_state;
    if (existing.side === "flat" || existing.quantity <= 0) {
      reasons.push("invalid model exit decision: no open position");
      return { approved: false, reasons: unique(reasons), normalizedSignal };
    }

    const quantity =
      normalizedSignal.bias === "CLOSE"
        ? existing.quantity
        : normalizeQuantity(executionPlan.quantity, context.market_snapshot.filters);

    if (quantity <= 0) {
      reasons.push("reduction quantity rounds to zero");
      return { approved: false, reasons: unique(reasons), normalizedSignal };
    }

    return {
      approved: unique(reasons).length === 0,
      reasons: unique(reasons),
      normalizedSignal,
      executionPlan: {
        ...executionPlan,
        quantity
      }
    };
  }

  private evaluateEntry(
    context: DecisionContext,
    normalizedSignal: StrategySignal,
    executionPlan: ExecutionPlan,
    reasons: string[]
  ): RiskEvaluation {
    if (context.position_state.side !== "flat") {
      reasons.push("max one open position allowed");
    }
    if (context.account_state.openOrders >= this.config.riskPolicy.maxOpenPositions) {
      reasons.push("open order limit reached");
    }
    if (executionPlan.stopLoss === undefined || executionPlan.tp2 === undefined || executionPlan.initialRiskPerUnit === undefined) {
      reasons.push("execution plan is incomplete");
      return { approved: false, reasons: unique(reasons), normalizedSignal };
    }

    const entry = executionPlan.entryPrice;
    const isLong = normalizedSignal.bias === "LONG";
    const rr = riskRewardRatio(entry, executionPlan.stopLoss, executionPlan.tp2);
    if (rr < this.config.riskPolicy.minRiskReward) {
      reasons.push(`risk/reward below minimum (${rr.toFixed(2)} < ${this.config.riskPolicy.minRiskReward})`);
    }

    const stopDistancePct = executionPlan.initialRiskPerUnit / entry;
    if (stopDistancePct <= 0) {
      reasons.push("invalid stop distance");
    }

    if (isLong) {
      if (executionPlan.stopLoss >= entry) {
        reasons.push("long stop_loss must be below entry");
      }
      if (executionPlan.tp1 !== undefined && executionPlan.tp1 <= entry) {
        reasons.push("long tp1 must be above entry");
      }
      if (executionPlan.tp2 <= entry) {
        reasons.push("long tp2 must be above entry");
      }
    } else {
      if (executionPlan.stopLoss <= entry) {
        reasons.push("short stop_loss must be above entry");
      }
      if (executionPlan.tp1 !== undefined && executionPlan.tp1 >= entry) {
        reasons.push("short tp1 must be below entry");
      }
      if (executionPlan.tp2 >= entry) {
        reasons.push("short tp2 must be below entry");
      }
    }

    if (executionPlan.quantity <= 0) {
      reasons.push("calculated quantity is below exchange minimum");
    }

    if (
      context.market_snapshot.filters?.minNotional !== undefined &&
      executionPlan.quantity * entry < context.market_snapshot.filters.minNotional
    ) {
      reasons.push("notional is below exchange minimum");
    }

    return {
      approved: unique(reasons).length === 0,
      reasons: unique(reasons),
      normalizedSignal,
      executionPlan
    };
  }
}

const unique = (reasons: string[]): string[] => [...new Set(reasons)];
