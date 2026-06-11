import type { AppConfig } from "../config.js";
import type {
  DecisionContext,
  ExecutionPlan,
  MarketRegime,
  StrategySignal,
  TradeAction
} from "../domain/types.js";
import { clamp, normalizeQuantity, roundToTickLong, roundToTickShort } from "../lib/math.js";

export interface PlanningResult {
  normalizedSignal: StrategySignal;
  plan?: ExecutionPlan;
  reasons: string[];
}

type Alignment = {
  aligned: boolean;
  minConfidence: number;
  sizeMultiplier: number;
  leverageCap: number;
  reasons: string[];
};

const isEntryBias = (bias: TradeAction): boolean => bias === "LONG" || bias === "SHORT";

export class StrategyPlanner {
  public constructor(private readonly config: AppConfig) {}

  public plan(context: DecisionContext, signal: StrategySignal): PlanningResult {
    const normalizedSignal: StrategySignal = {
      ...signal,
      confidence: clamp(signal.confidence, 0, 1),
      holding_horizon_minutes: Math.min(Math.max(signal.holding_horizon_minutes, 1), 1_440)
    };

    if (!isEntryBias(normalizedSignal.bias)) {
      return {
        normalizedSignal,
        plan: this.planPositionManagement(context, normalizedSignal),
        reasons: []
      };
    }

    const reasons: string[] = [];
    const alignment = this.assessAlignment(context, normalizedSignal);
    reasons.push(...alignment.reasons);

    if (normalizedSignal.confidence < alignment.minConfidence) {
      reasons.push("confidence below regime threshold");
    }

    const entryPrice = context.market_snapshot.markPrice;
    const invalidationPrice = normalizedSignal.invalidation_price ?? undefined;
    if (invalidationPrice === undefined) {
      reasons.push("missing invalidation price");
      return { normalizedSignal, reasons };
    }

    const isLong = normalizedSignal.bias === "LONG";
    const roundedInvalidationPrice = isLong
      ? roundToTickLong(invalidationPrice, context.market_snapshot.tickSize)
      : roundToTickShort(invalidationPrice, context.market_snapshot.tickSize);

    if (isLong && roundedInvalidationPrice >= entryPrice) {
      reasons.push("long invalidation must be below entry");
    }
    if (!isLong && roundedInvalidationPrice <= entryPrice) {
      reasons.push("short invalidation must be above entry");
    }

    const initialRiskPerUnit = Math.abs(entryPrice - roundedInvalidationPrice);
    const distancePct = initialRiskPerUnit / entryPrice;
    if (distancePct < 0.0025 || distancePct > 0.018) {
      // ... rest of the code remains the same ...