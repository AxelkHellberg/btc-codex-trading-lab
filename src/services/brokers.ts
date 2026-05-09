import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type {
  AccountState,
  DecisionContext,
  ExecutionPlan,
  ExecutionResult,
  MarketSnapshot,
  PersistedTradeRecord,
  PositionDirection,
  PositionState
} from "../domain/types.js";
import { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { estimateSlippagePrice, roundToTick, signedPnl } from "../lib/math.js";

export interface Broker {
  readonly name: string;
  execute(plan: ExecutionPlan, context: DecisionContext): Promise<ExecutionResult>;
  onMarketSnapshot?(snapshot: MarketSnapshot): Promise<ExecutionResult | null>;
  getState?(): { accountState: AccountState; positionState: PositionState };
}

export class PaperBroker implements Broker {
  public readonly name = "paper";
  private account: AccountState;
  private position: PositionState;
  private peakEquity: number;
  private activeTrade: PersistedTradeRecord | null = null;

  public constructor(private readonly config: AppConfig) {
    const now = Date.now();
    this.account = {
      equity: config.paperStartingBalance,
      walletBalance: config.paperStartingBalance,
      availableBalance: config.paperStartingBalance,
      dailyPnl: 0,
      weeklyDrawdown: 0,
      consecutiveLosses: 0,
      openOrders: 0,
      updatedAt: now
    };
    this.position = {
      side: "flat",
      quantity: 0,
      entryPrice: 0,
      markPrice: 0,
      leverage: 1,
      unrealizedPnl: 0,
      realizedPnl: 0
    };
    this.peakEquity = config.paperStartingBalance;
  }

  public async execute(plan: ExecutionPlan, context: DecisionContext): Promise<ExecutionResult> {
    if (plan.action === "LONG" || plan.action === "SHORT") {
      return this.openPosition(plan, context.market_snapshot);
    }

    return this.closeOrReducePosition(
      plan,
      context.market_snapshot,
      plan.action === "REDUCE" ? "decision_reduce" : "decision"
    );
  }

  public async onMarketSnapshot(snapshot: MarketSnapshot): Promise<ExecutionResult | null> {
    if (this.position.side === "flat" || this.position.quantity <= 0) {
      return null;
    }

    this.markToMarket(snapshot.markPrice);

    const lifecycleAdjustment = this.advanceLifecycle(snapshot);
    if (lifecycleAdjustment) {
      return lifecycleAdjustment;
    }

    const exitReason = this.resolveExitReason(snapshot);
    if (!exitReason) {
      return null;
    }

    return this.closeOrReducePosition(
      {
        action: "CLOSE",
        side: this.position.side === "long" ? "SELL" : "BUY",
        entryType: "MARKET",
        leverage: this.position.leverage,
        quantity: this.position.quantity,
        notionalUsd: this.position.quantity * snapshot.markPrice,
        entryPrice: snapshot.markPrice,
        stopLoss: this.position.stopLoss,
        tp1: this.position.tp1,
        tp2: this.position.tp2 ?? this.position.takeProfit,
        breakEvenTriggerR: this.position.breakEvenTriggerR,
        trailingTriggerR: this.position.trailingTriggerR,
        trailingOffset: this.position.trailingOffset,
        initialRiskPerUnit: this.position.initialRiskPerUnit,
        maxHoldUntil: this.position.maxHoldUntil,
        confidence: 1,
        setupType: this.position.setupType,
        regimeAtEntry: this.position.regimeAtEntry,
        entryReason: this.position.entryReason ?? exitReason,
        reasoningSummary: exitReason,
        invalidationPrice: this.position.stopLoss
      },
      snapshot,
      exitReason
    );
  }

  public getState(): { accountState: AccountState; positionState: PositionState } {
    return {
      accountState: { ...this.account },
      positionState: { ...this.position }
    };
  }

  private openPosition(plan: ExecutionPlan, market: MarketSnapshot): ExecutionResult {
    const tradeId = randomUUID();
    const fillPrice = estimateSlippagePrice(market.markPrice, this.config.slippageBps, plan.side);
    const fee = fillPrice * plan.quantity * (this.config.takerFeeBps / 10_000);
    const side: PositionDirection = plan.side === "BUY" ? "long" : "short";
    const now = Date.now();

    this.account.walletBalance -= fee;
    this.account.availableBalance = Math.max(0, this.account.walletBalance - (fillPrice * plan.quantity) / plan.leverage);
    this.account.openOrders = 2;

    this.position = {
      side,
      quantity: plan.quantity,
      entryPrice: fillPrice,
      markPrice: market.markPrice,
      leverage: plan.leverage,
      unrealizedPnl: 0,
      realizedPnl: 0,
      stopLoss: plan.stopLoss,
      takeProfit: plan.tp2,
      tp1: plan.tp1,
      tp2: plan.tp2,
      openedAt: now,
      maxHoldUntil: plan.maxHoldUntil,
      sourceTradeId: tradeId,
      initialRiskPerUnit: plan.initialRiskPerUnit,
      breakEvenArmed: false,
      trailingActive: false,
      tp1Filled: false,
      breakEvenTriggerR: plan.breakEvenTriggerR,
      trailingTriggerR: plan.trailingTriggerR,
      trailingOffset: plan.trailingOffset,
      peakUnrealizedPnl: 0,
      mfe: 0,
      mae: 0,
      entryFee: fee,
      exitFeePaid: 0,
      grossRealizedPnl: 0,
      netRealizedPnl: -fee,
      setupType: plan.setupType,
      regimeAtEntry: plan.regimeAtEntry,
      entryReason: plan.entryReason
    };

    this.activeTrade = {
      tradeId,
      mode: this.config.tradingMode,
      action: plan.action,
      side: plan.side,
      quantity: plan.quantity,
      remainingQuantity: plan.quantity,
      leverage: plan.leverage,
      entryPrice: fillPrice,
      stopLoss: plan.stopLoss,
      takeProfit: plan.tp2,
      tp1: plan.tp1,
      tp2: plan.tp2,
      confidence: plan.confidence,
      setupType: plan.setupType,
      status: "open",
      entryReason: plan.entryReason,
      regimeAtEntry: plan.regimeAtEntry,
      entryFee: fee,
      exitFee: 0,
      grossPnl: 0,
      netPnl: -fee,
      mfe: 0,
      mae: 0,
      openedAt: now,
      details: {
        message: `Opened ${side} ${plan.quantity} ${market.symbol} @ ${fillPrice}`,
        raw: { fillPrice, fee },
        reasoning: plan.reasoningSummary
      },
      createdAt: now,
      updatedAt: now
    };

    this.markToMarket(market.markPrice);

    return {
      tradeId,
      accepted: true,
      broker: this.name,
      message: `Opened ${side} ${plan.quantity} ${market.symbol} @ ${fillPrice}`,
      positionState: { ...this.position },
      accountState: { ...this.account },
      tradeRecord: this.cloneTradeRecord(),
      raw: { fillPrice, fee }
    };
  }

  private advanceLifecycle(snapshot: MarketSnapshot): ExecutionResult | null {
    const favorableMove = this.getFavorableMove(snapshot.markPrice);
    const initialRisk = this.position.initialRiskPerUnit ?? 0;
    const tickSize = snapshot.filters?.tickSize ?? 0.1;

    if (
      !this.position.breakEvenArmed &&
      initialRisk > 0 &&
      favorableMove >= initialRisk * (this.position.breakEvenTriggerR ?? 1)
    ) {
      this.position = {
        ...this.position,
        stopLoss: roundToTick(this.position.entryPrice, tickSize),
        breakEvenArmed: true
      };
    }

    if (!this.position.tp1Filled && this.position.tp1 !== undefined && this.hasHitTp1(snapshot.markPrice)) {
      const partialQuantity = this.position.quantity * 0.5;
      return this.closeOrReducePosition(
        {
          action: "REDUCE",
          side: this.position.side === "long" ? "SELL" : "BUY",
          entryType: "MARKET",
          leverage: this.position.leverage,
          quantity: partialQuantity,
          notionalUsd: partialQuantity * snapshot.markPrice,
          entryPrice: snapshot.markPrice,
          stopLoss: this.position.stopLoss,
          tp1: this.position.tp1,
          tp2: this.position.tp2 ?? this.position.takeProfit,
          breakEvenTriggerR: this.position.breakEvenTriggerR,
          trailingTriggerR: this.position.trailingTriggerR,
          trailingOffset: this.position.trailingOffset,
          initialRiskPerUnit: this.position.initialRiskPerUnit,
          maxHoldUntil: this.position.maxHoldUntil,
          confidence: 1,
          setupType: this.position.setupType,
          regimeAtEntry: this.position.regimeAtEntry,
          entryReason: this.position.entryReason ?? "partial take profit",
          reasoningSummary: "partial take profit",
          invalidationPrice: this.position.stopLoss
        },
        snapshot,
        "partial_take_profit"
      );
    }

    if (
      initialRisk > 0 &&
      favorableMove >= initialRisk * (this.position.trailingTriggerR ?? 2) &&
      this.position.trailingOffset !== undefined
    ) {
      const nextStop =
        this.position.side === "long"
          ? snapshot.markPrice - this.position.trailingOffset
          : snapshot.markPrice + this.position.trailingOffset;
      const roundedStop = roundToTick(nextStop, tickSize);
      const shouldTighten =
        this.position.side === "long"
          ? this.position.stopLoss === undefined || roundedStop > this.position.stopLoss
          : this.position.stopLoss === undefined || roundedStop < this.position.stopLoss;
      if (shouldTighten) {
        this.position = {
          ...this.position,
          trailingActive: true,
          stopLoss: roundedStop
        };
      }
    }

    return null;
  }

  private resolveExitReason(snapshot: MarketSnapshot): string | null {
    const stopHit =
      this.position.stopLoss !== undefined &&
      ((this.position.side === "long" && snapshot.markPrice <= this.position.stopLoss) ||
        (this.position.side === "short" && snapshot.markPrice >= this.position.stopLoss));
    const takeHit =
      (this.position.tp2 ?? this.position.takeProfit) !== undefined &&
      ((this.position.side === "long" && snapshot.markPrice >= (this.position.tp2 ?? this.position.takeProfit!)) ||
        (this.position.side === "short" && snapshot.markPrice <= (this.position.tp2 ?? this.position.takeProfit!)));
    const expired = this.position.maxHoldUntil !== undefined && Date.now() >= this.position.maxHoldUntil;

    if (stopHit) {
      if (this.position.trailingActive) {
        return "trailing_stop";
      }
      if (
        this.position.breakEvenArmed &&
        this.position.stopLoss !== undefined &&
        Math.abs(this.position.stopLoss - this.position.entryPrice) <= (snapshot.filters?.tickSize ?? 0.1) * 2
      ) {
        return "break_even";
      }
      return "stop_loss";
    }

    if (takeHit) {
      return "take_profit";
    }

    if (expired) {
      return "time_exit";
    }

    return null;
  }

  private closeOrReducePosition(plan: ExecutionPlan, market: MarketSnapshot, reason: string): ExecutionResult {
    const tradeId = this.position.sourceTradeId ?? randomUUID();
    if (this.position.side === "flat" || this.position.quantity <= 0) {
      return {
        tradeId,
        accepted: false,
        broker: this.name,
        message: "No position to close",
        positionState: { ...this.position },
        accountState: { ...this.account }
      };
    }

    const closeQty = Math.min(plan.quantity, this.position.quantity);
    const exitPrice = estimateSlippagePrice(market.markPrice, this.config.slippageBps, plan.side);
    const grossPnl = signedPnl(this.position.side, this.position.entryPrice, exitPrice, closeQty);
    const fee = exitPrice * closeQty * (this.config.takerFeeBps / 10_000);
    const netPnl = grossPnl - fee;
    const now = Date.now();

    this.account.walletBalance += netPnl;
    this.account.dailyPnl += netPnl;
    this.account.consecutiveLosses = netPnl < 0 ? this.account.consecutiveLosses + 1 : 0;
    this.account.lastLossAt = netPnl < 0 ? now : undefined;

    const remainingQty = this.position.quantity - closeQty;
    const cumulativeExitFee = (this.position.exitFeePaid ?? 0) + fee;
    const cumulativeGross = (this.position.grossRealizedPnl ?? 0) + grossPnl;
    const cumulativeNet = (this.position.netRealizedPnl ?? -(this.position.entryFee ?? 0)) + netPnl;

    if (remainingQty <= 0.0000001) {
      this.position = {
        side: "flat",
        quantity: 0,
        entryPrice: 0,
        markPrice: market.markPrice,
        leverage: 1,
        unrealizedPnl: 0,
        realizedPnl: cumulativeNet
      };
      this.account.openOrders = 0;
      this.account.availableBalance = this.account.walletBalance;
    } else {
      this.position = {
        ...this.position,
        quantity: remainingQty,
        realizedPnl: cumulativeNet,
        tp1Filled: this.position.tp1Filled || reason === "partial_take_profit",
        exitFeePaid: cumulativeExitFee,
        grossRealizedPnl: cumulativeGross,
        netRealizedPnl: cumulativeNet,
        takeProfit: this.position.tp2 ?? this.position.takeProfit
      };
    }

    this.markToMarket(market.markPrice);
    this.syncActiveTrade(reason, closeQty, grossPnl, fee, netPnl, remainingQty, exitPrice, now);

    return {
      tradeId,
      accepted: true,
      broker: this.name,
      message:
        reason === "partial_take_profit"
          ? `Partial ${reason} @ ${exitPrice}, pnl=${netPnl.toFixed(2)}`
          : `Exit ${reason} @ ${exitPrice}, pnl=${netPnl.toFixed(2)}`,
      positionState: { ...this.position },
      accountState: { ...this.account },
      tradeRecord: this.cloneTradeRecord(),
      raw: { exitPrice, grossPnl, fee, reason }
    };
  }

  private syncActiveTrade(
    reason: string,
    closedQuantity: number,
    grossPnl: number,
    fee: number,
    netPnl: number,
    remainingQuantity: number,
    exitPrice: number,
    now: number
  ): void {
    if (!this.activeTrade) {
      return;
    }

    const closed = remainingQuantity <= 0.0000001;
    this.activeTrade = {
      ...this.activeTrade,
      remainingQuantity: Math.max(0, remainingQuantity),
      stopLoss: this.position.stopLoss,
      takeProfit: this.position.takeProfit,
      tp1: this.position.tp1,
      tp2: this.position.tp2,
      status: closed ? "closed" : "partial",
      exitReason: closed ? reason : this.activeTrade.exitReason,
      exitFee: this.activeTrade.exitFee + fee,
      grossPnl: this.activeTrade.grossPnl + grossPnl,
      netPnl: this.activeTrade.netPnl + netPnl,
      mfe: this.position.mfe ?? this.activeTrade.mfe,
      mae: this.position.mae ?? this.activeTrade.mae,
      closedAt: closed ? now : undefined,
      holdingMinutes: closed ? (now - this.activeTrade.openedAt) / 60_000 : undefined,
      details: {
        message:
          reason === "partial_take_profit"
            ? `Partial ${reason} @ ${exitPrice}, qty=${closedQuantity}, pnl=${netPnl.toFixed(2)}`
            : `Exit ${reason} @ ${exitPrice}, pnl=${netPnl.toFixed(2)}`,
        raw: { exitPrice, grossPnl, fee, reason },
        reasoning: reason
      },
      updatedAt: now
    };

    if (closed) {
      this.activeTrade = { ...this.activeTrade };
    }
  }

  private cloneTradeRecord(): PersistedTradeRecord | undefined {
    if (!this.activeTrade) {
      return undefined;
    }

    const record = { ...this.activeTrade };
    if (record.status === "closed") {
      this.activeTrade = null;
    }
    return record;
  }

  private markToMarket(markPrice: number): void {
    if (this.position.side === "flat" || this.position.quantity <= 0) {
      this.account.equity = this.account.walletBalance;
      this.account.weeklyDrawdown =
        this.peakEquity > 0 ? Math.max(0, (this.peakEquity - this.account.equity) / this.peakEquity) : 0;
      this.account.updatedAt = Date.now();
      return;
    }

    const unrealized = signedPnl(this.position.side, this.position.entryPrice, markPrice, this.position.quantity);
    const mfe = Math.max(this.position.mfe ?? 0, Math.max(unrealized, 0));
    const mae = Math.max(this.position.mae ?? 0, Math.max(-unrealized, 0));

    this.position = {
      ...this.position,
      markPrice,
      unrealizedPnl: unrealized,
      peakUnrealizedPnl: Math.max(this.position.peakUnrealizedPnl ?? 0, unrealized),
      mfe,
      mae
    };
    this.account.equity = this.account.walletBalance + unrealized;
    this.peakEquity = Math.max(this.peakEquity, this.account.equity);
    this.account.weeklyDrawdown =
      this.peakEquity > 0 ? Math.max(0, (this.peakEquity - this.account.equity) / this.peakEquity) : 0;
    this.account.updatedAt = Date.now();

    if (this.activeTrade) {
      this.activeTrade = {
        ...this.activeTrade,
        mfe,
        mae,
        stopLoss: this.position.stopLoss,
        takeProfit: this.position.takeProfit,
        tp1: this.position.tp1,
        tp2: this.position.tp2,
        updatedAt: Date.now()
      };
    }
  }

  private getFavorableMove(markPrice: number): number {
    return this.position.side === "long" ? markPrice - this.position.entryPrice : this.position.entryPrice - markPrice;
  }

  private hasHitTp1(markPrice: number): boolean {
    if (this.position.tp1 === undefined) {
      return false;
    }
    return this.position.side === "long" ? markPrice >= this.position.tp1 : markPrice <= this.position.tp1;
  }
}

export class LiveBroker implements Broker {
  public readonly name = "binance-live";
  private activeTrade: PersistedTradeRecord | null = null;

  public constructor(
    private readonly config: AppConfig,
    private readonly client: BinanceFuturesClient,
    private readonly logger: Logger
  ) {}

  public async execute(plan: ExecutionPlan, context: DecisionContext): Promise<ExecutionResult> {
    const tradeId = context.position_state.sourceTradeId ?? randomUUID();

    if (plan.action === "LONG" || plan.action === "SHORT") {
      await this.client.changeLeverage(this.config.symbol, plan.leverage);
      const openOrder = await this.client.createOrder({
        symbol: this.config.symbol,
        side: plan.side,
        type: "MARKET",
        quantity: plan.quantity,
        newOrderRespType: "RESULT",
        newClientOrderId: `entry-${tradeId}`
      });
      await this.placeProtectionOrders(tradeId, plan.side, plan.quantity, plan.stopLoss, plan.tp2);
      const [accountState, positionState] = await Promise.all([
        this.client.getBalanceState(),
        this.client.getPositionState(this.config.symbol)
      ]);
      const now = Date.now();
      this.activeTrade = {
        tradeId,
        mode: this.config.tradingMode,
        action: plan.action,
        side: plan.side,
        quantity: plan.quantity,
        remainingQuantity: positionState.quantity,
        leverage: plan.leverage,
        entryPrice: plan.entryPrice,
        stopLoss: plan.stopLoss,
        takeProfit: plan.tp2,
        tp1: plan.tp1,
        tp2: plan.tp2,
        confidence: plan.confidence,
        setupType: plan.setupType,
        status: "open",
        entryReason: plan.entryReason,
        regimeAtEntry: plan.regimeAtEntry,
        entryFee: 0,
        exitFee: 0,
        grossPnl: 0,
        netPnl: 0,
        mfe: 0,
        mae: 0,
        openedAt: now,
        details: {
          message: `Live order accepted ${plan.action} ${plan.quantity} ${this.config.symbol}`,
          raw: openOrder,
          reasoning: plan.reasoningSummary
        },
        createdAt: now,
        updatedAt: now
      };

      return {
        tradeId,
        accepted: true,
        broker: this.name,
        message: `Live order accepted ${plan.action} ${plan.quantity} ${this.config.symbol}`,
        positionState,
        accountState,
        tradeRecord: { ...this.activeTrade },
        raw: openOrder
      };
    }

    await this.client.cancelAllOrders(this.config.symbol);
    const closeOrder = await this.client.createOrder({
      symbol: this.config.symbol,
      side: plan.side,
      type: "MARKET",
      quantity: plan.quantity,
      reduceOnly: true,
      newOrderRespType: "RESULT",
      newClientOrderId: `close-${tradeId}`
    });
    const [accountState, positionState] = await Promise.all([
      this.client.getBalanceState(),
      this.client.getPositionState(this.config.symbol)
    ]);
    if (positionState.quantity > 0 && this.activeTrade) {
      await this.placeProtectionOrders(
        tradeId,
        this.activeTrade.side,
        positionState.quantity,
        this.activeTrade.stopLoss,
        this.activeTrade.takeProfit,
        "remaining"
      );
    }
    const now = Date.now();
    const tradeRecord =
      this.activeTrade === null
        ? undefined
        : {
            ...this.activeTrade,
            remainingQuantity: positionState.quantity,
            status: positionState.quantity > 0 ? "partial" : "closed",
            exitReason: plan.action === "REDUCE" ? "decision_reduce" : "decision",
            closedAt: positionState.quantity > 0 ? undefined : now,
            holdingMinutes: positionState.quantity > 0 ? undefined : (now - this.activeTrade.openedAt) / 60_000,
            details: {
              message: `Live ${plan.action.toLowerCase()} executed`,
              raw: closeOrder,
              reasoning: plan.reasoningSummary
            },
            updatedAt: now
          };

    if (tradeRecord?.status === "closed") {
      this.activeTrade = null;
    } else if (tradeRecord) {
      this.activeTrade = tradeRecord;
    }

    return {
      tradeId,
      accepted: true,
      broker: this.name,
      message: `Live ${plan.action.toLowerCase()} executed`,
      positionState,
      accountState,
      tradeRecord,
      raw: closeOrder
    };
  }

  private async placeProtectionOrders(
    tradeId: string,
    entrySide: "BUY" | "SELL",
    quantity: number,
    stopLoss?: number,
    takeProfit?: number,
    clientOrderSuffix?: string
  ): Promise<void> {
    const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
    const suffix = clientOrderSuffix ? `-${clientOrderSuffix}` : "";

    if (stopLoss !== undefined) {
      await this.client.createOrder({
        symbol: this.config.symbol,
        side: exitSide,
        type: "STOP_MARKET",
        stopPrice: stopLoss,
        quantity,
        reduceOnly: true,
        workingType: "CONTRACT_PRICE",
        newClientOrderId: `stop-${tradeId}${suffix}`
      });
    }
    if (takeProfit !== undefined) {
      await this.client.createOrder({
        symbol: this.config.symbol,
        side: exitSide,
        type: "TAKE_PROFIT_MARKET",
        stopPrice: takeProfit,
        quantity,
        reduceOnly: true,
        workingType: "CONTRACT_PRICE",
        newClientOrderId: `tp-${tradeId}${suffix}`
      });
    }
  }

  public getState(): { accountState: AccountState; positionState: PositionState } {
    return {
      accountState: {
        equity: 0,
        walletBalance: 0,
        availableBalance: 0,
        dailyPnl: 0,
        weeklyDrawdown: 0,
        consecutiveLosses: 0,
        openOrders: 0,
        updatedAt: Date.now()
      },
      positionState: {
        side: "flat",
        quantity: 0,
        entryPrice: 0,
        markPrice: 0,
        leverage: 1,
        unrealizedPnl: 0,
        realizedPnl: 0
      }
    };
  }
}
