import type { AppConfig } from "../config.js";
import type {
  DecisionContext,
  ExecutionPlan,
  MarketRegime,
  StrategySignal,
  TradeAction
} from "../domain/types.js";
import { clamp, normalizeQuantity, roundToTick } from "../lib/math.js";

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
    if (isLong && invalidationPrice >= entryPrice) {
      reasons.push("long invalidation must be below entry");
    }
    if (!isLong && invalidationPrice <= entryPrice) {
      reasons.push("short invalidation must be above entry");
    }

    const initialRiskPerUnit = Math.abs(entryPrice - invalidationPrice);
    const distancePct = initialRiskPerUnit / entryPrice;
    if (distancePct < 0.0025 || distancePct > 0.018) {
      reasons.push("distance to invalidation not sane");
    }

    const baseLeverage = normalizedSignal.setup_type === "reversal" || context.context_summary.regime === "range" ? 1 : 2;
    const leverage = Math.min(
      this.config.riskPolicy.maxLeverage,
      alignment.leverageCap,
      normalizedSignal.confidence >= 0.72 && context.market_snapshot.volumeAcceleration >= 1 ? 3 : baseLeverage
    );

    const baseSizePct =
      normalizedSignal.setup_type === "range_reversion" || normalizedSignal.setup_type === "reversal" ? 0.07 : 0.11;
    const sizePct = clamp(baseSizePct * alignment.sizeMultiplier * (0.9 + normalizedSignal.confidence * 0.35), 0.03, 0.18);
    const capitalByRisk =
      distancePct > 0 ? (context.account_state.equity * this.config.riskPolicy.riskPerTrade) / distancePct : 0;
    const capitalBySize = context.account_state.equity * sizePct * leverage;
    const allowedNotional = Math.min(capitalByRisk, capitalBySize);
    const quantity = normalizeQuantity(allowedNotional / entryPrice, context.market_snapshot.filters);
    if (quantity <= 0) {
      reasons.push("calculated quantity is below exchange minimum");
    }

    const side = isLong ? "BUY" : "SELL";
    const tickSize = context.market_snapshot.filters?.tickSize ?? 0.1;
    const tp1Raw = isLong ? entryPrice + initialRiskPerUnit * 1.5 : entryPrice - initialRiskPerUnit * 1.5;
    const tp2Raw = isLong ? entryPrice + initialRiskPerUnit * 3 : entryPrice - initialRiskPerUnit * 3;
    const trailingOffset = initialRiskPerUnit;

    return {
      normalizedSignal,
      reasons,
      plan: {
        action: normalizedSignal.bias,
        side,
        entryType: "MARKET",
        leverage,
        quantity,
        notionalUsd: quantity * entryPrice,
        entryPrice,
        stopLoss: roundToTick(invalidationPrice, tickSize),
        tp1: roundToTick(tp1Raw, tickSize),
        tp2: roundToTick(tp2Raw, tickSize),
        breakEvenTriggerR: 1,
        trailingTriggerR: 2,
        trailingOffset: roundToTick(trailingOffset, tickSize),
        initialRiskPerUnit: roundToTick(initialRiskPerUnit, tickSize),
        maxHoldUntil: Date.now() + normalizedSignal.holding_horizon_minutes * 60_000,
        confidence: normalizedSignal.confidence,
        setupType: normalizedSignal.setup_type,
        regimeAtEntry: context.context_summary.regime,
        entryReason: normalizedSignal.reasoning_summary,
        reasoningSummary: normalizedSignal.reasoning_summary,
        invalidationPrice: roundToTick(invalidationPrice, tickSize)
      }
    };
  }

  private planPositionManagement(context: DecisionContext, signal: StrategySignal): ExecutionPlan | undefined {
    if (signal.bias === "FLAT") {
      return undefined;
    }

    const existing = context.position_state;
    if (existing.side === "flat" || existing.quantity <= 0) {
      return undefined;
    }

    const quantity =
      signal.bias === "CLOSE"
        ? existing.quantity
        : normalizeQuantity(
            Math.max(existing.quantity * 0.5, context.market_snapshot.filters?.minQty ?? 0),
            context.market_snapshot.filters
          ) || existing.quantity;

    return {
      action: signal.bias,
      side: existing.side === "long" ? "SELL" : "BUY",
      entryType: "MARKET",
      leverage: existing.leverage,
      quantity,
      notionalUsd: quantity * context.market_snapshot.markPrice,
      entryPrice: context.market_snapshot.markPrice,
      stopLoss: existing.stopLoss,
      tp1: existing.tp1,
      tp2: existing.tp2 ?? existing.takeProfit,
      breakEvenTriggerR: existing.breakEvenTriggerR,
      trailingTriggerR: existing.trailingTriggerR,
      trailingOffset: existing.trailingOffset,
      initialRiskPerUnit: existing.initialRiskPerUnit,
      maxHoldUntil: existing.maxHoldUntil,
      confidence: signal.confidence,
      setupType: signal.setup_type,
      regimeAtEntry: existing.regimeAtEntry,
      entryReason: signal.reasoning_summary,
      reasoningSummary: signal.reasoning_summary,
      invalidationPrice: signal.invalidation_price
    };
  }

  private assessAlignment(context: DecisionContext, signal: StrategySignal): Alignment {
    const regime = context.context_summary.regime;
    const trendBias = context.context_summary.trend_bias;
    const setup = signal.setup_type;

    const rangeReversal = setup === "range_reversion" || setup === "reversal";
    const trendContinuation = setup === "continuation" || setup === "breakout";

    if (regime === "trend_up") {
      if (signal.bias === "LONG" && trendContinuation) {
        return { aligned: true, minConfidence: 0.4, sizeMultiplier: 1, leverageCap: 3, reasons: [] };
      }
      if (signal.bias === "SHORT" && rangeReversal) {
        return { aligned: true, minConfidence: 0.72, sizeMultiplier: 0.45, leverageCap: 1, reasons: [] };
      }
      return { aligned: false, minConfidence: 0.4, sizeMultiplier: 0, leverageCap: 1, reasons: ["regime misaligned for entry"] };
    }

    if (regime === "trend_down") {
      if (signal.bias === "SHORT" && trendContinuation) {
        return { aligned: true, minConfidence: 0.4, sizeMultiplier: 1, leverageCap: 3, reasons: [] };
      }
      if (signal.bias === "LONG" && rangeReversal) {
        return { aligned: true, minConfidence: 0.72, sizeMultiplier: 0.45, leverageCap: 1, reasons: [] };
      }
      return { aligned: false, minConfidence: 0.4, sizeMultiplier: 0, leverageCap: 1, reasons: ["regime misaligned for entry"] };
    }

    if (regime === "range") {
      if (rangeReversal) {
        return { aligned: true, minConfidence: 0.3, sizeMultiplier: 0.6, leverageCap: 1, reasons: [] };
      }
      return { aligned: false, minConfidence: 0.3, sizeMultiplier: 0, leverageCap: 1, reasons: ["range regime requires explicit reversion setup"] };
    }

    const biasAligned =
      (signal.bias === "LONG" && trendBias === "bullish") || (signal.bias === "SHORT" && trendBias === "bearish");
    if (biasAligned && trendContinuation) {
      return { aligned: true, minConfidence: 0.45, sizeMultiplier: 0.5, leverageCap: 1, reasons: [] };
    }

    return { aligned: false, minConfidence: 0.45, sizeMultiplier: 0, leverageCap: 1, reasons: ["transition regime requires stronger aligned continuation"] };
  }
}
