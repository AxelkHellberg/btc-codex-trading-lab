import type { AppConfig } from "../config.js";
import type { DecisionContext, ExecutionPlan } from "../domain/types.js";

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export function entrySizingReasons(context: DecisionContext, config: AppConfig): string[] {
  const reasons: string[] = [];
  for (const [name, value] of Object.entries({
    equity: context.account_state.equity,
    markPrice: context.market_snapshot.markPrice,
    riskPerTrade: config.riskPolicy.riskPerTrade,
    maxLeverage: config.riskPolicy.maxLeverage
  })) {
    if (!positive(value)) reasons.push(`invalid entry ${name}: expected a finite positive number`);
  }
  const filters = context.market_snapshot.filters;
  if (filters) {
    for (const name of ["tickSize", "stepSize", "minQty"] as const) {
      if (!positive(filters[name])) reasons.push(`invalid entry ${name}: expected a finite positive number`);
    }
    if (filters.minNotional !== undefined && (!Number.isFinite(filters.minNotional) || filters.minNotional < 0)) {
      reasons.push("invalid entry minNotional: expected a finite nonnegative number");
    }
  }
  return reasons;
}

export function entryPlanReasons(plan: ExecutionPlan): string[] {
  const reasons: string[] = [];
  for (const name of ["quantity", "entryPrice", "notionalUsd", "leverage", "stopLoss", "tp2", "initialRiskPerUnit"] as const) {
    if (!positive(plan[name])) reasons.push(`invalid entry ${name}: expected a finite positive number`);
  }
  for (const name of ["tp1", "trailingOffset", "breakEvenTriggerR", "trailingTriggerR", "maxHoldUntil", "invalidationPrice"] as const) {
    if (plan[name] !== undefined && !positive(plan[name])) {
      reasons.push(`invalid entry ${name}: expected a finite positive number`);
    }
  }
  if (!Number.isFinite(plan.confidence) || plan.confidence < 0 || plan.confidence > 1) {
    reasons.push("invalid entry confidence: expected a finite fraction");
  }
  if (!positive(plan.quantity * plan.entryPrice) || !positive(plan.quantity * plan.entryPrice / plan.leverage)) {
    reasons.push("invalid entry notional or margin arithmetic");
  }
  return reasons;
}
