export type TradingMode = "paper" | "live";
export type PositionDirection = "flat" | "long" | "short";
export type TradeAction = "LONG" | "SHORT" | "FLAT" | "CLOSE" | "REDUCE";
export type TradeEntryType = "MARKET" | "LIMIT";
export type StrategySetupType =
  | "continuation"
  | "breakout"
  | "reversal"
  | "range_reversion"
  | "momentum_exit"
  | "protective_exit";
export type MarketRegime = "trend_up" | "trend_down" | "range" | "transition";
export type TriggerReason =
  | "minute_recheck"
  | "market_breakout"
  | "open_interest_spike"
  | "funding_extreme"
  | "news_relevant"
  | "macro_relevant"
  | "onchain_shift"
  | "manual_recheck";

export interface SymbolFilters {
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional?: number;
}

export interface MarketSnapshot {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  lastPrice: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  fundingRate: number;
  nextFundingTime: number;
  openInterest: number;
  openInterestChangePct1m: number;
  topTraderLongShortRatio: number;
  volume1m: number;
  priceChangePct1m: number;
  priceChangePct5m: number;
  priceChangePct15m: number;
  priceChangePct1h: number;
  intradayHigh: number;
  intradayLow: number;
  distanceFromIntradayHighPct: number;
  distanceFromIntradayLowPct: number;
  emaFast: number;
  emaMedium: number;
  trendStrengthPct: number;
  volumeAcceleration: number;
  timestamp: number;
  filters?: SymbolFilters;
}

export interface NewsEvent {
  id: string;
  source: string;
  title: string;
  url?: string;
  publishedAt: number;
  relevanceScore: number;
  sentimentScore: number;
  tags: string[];
}

export interface OnchainSnapshot {
  mempoolTxCount: number;
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  tipHeight: number;
  difficultyAdjustment: number;
  blockCadenceSeconds: number;
  timestamp: number;
}

export interface PositionState {
  side: PositionDirection;
  quantity: number;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  unrealizedPnl: number;
  realizedPnl: number;
  stopLoss?: number;
  takeProfit?: number;
  tp1?: number;
  tp2?: number;
  openedAt?: number;
  maxHoldUntil?: number;
  sourceTradeId?: string;
  initialRiskPerUnit?: number;
  breakEvenArmed?: boolean;
  trailingActive?: boolean;
  tp1Filled?: boolean;
  breakEvenTriggerR?: number;
  trailingTriggerR?: number;
  trailingOffset?: number;
  peakUnrealizedPnl?: number;
  mfe?: number;
  mae?: number;
  entryFee?: number;
  exitFeePaid?: number;
  grossRealizedPnl?: number;
  netRealizedPnl?: number;
  setupType?: StrategySetupType;
  regimeAtEntry?: MarketRegime;
  entryReason?: string;
}

export interface AccountState {
  equity: number;
  walletBalance: number;
  availableBalance: number;
  dailyPnl: number;
  weeklyDrawdown: number;
  consecutiveLosses: number;
  openOrders: number;
  updatedAt: number;
  lastLossAt?: number;
}

export interface RiskState {
  withinDailyLossLimit: boolean;
  withinWeeklyDrawdown: boolean;
  cooldownActive: boolean;
  reasons: string[];
}

export interface DecisionContext {
  market_snapshot: MarketSnapshot;
  derivatives_snapshot: {
    funding_rate: number;
    next_funding_time: number;
    open_interest: number;
    open_interest_change_pct_1m: number;
    top_trader_long_short_ratio: number;
  };
  news_events: NewsEvent[];
  onchain_snapshot: OnchainSnapshot | null;
  position_state: PositionState;
  account_state: AccountState;
  risk_state: RiskState;
  context_summary: {
    regime: MarketRegime;
    trend_bias: "bullish" | "bearish" | "neutral";
    catalyst_bias: "bullish" | "bearish" | "neutral";
    momentum_score: number;
    key_levels: {
      intraday_high: number;
      intraday_low: number;
    };
    notes: string[];
  };
  trigger: {
    reason: TriggerReason;
    priority: number;
    details: string;
    triggeredAt: number;
  };
}

export interface StrategySignal {
  bias: TradeAction;
  confidence: number;
  setup_type: StrategySetupType;
  invalidation_price?: number;
  holding_horizon_minutes: number;
  reasoning_summary: string;
}

export interface RiskPolicy {
  maxLeverage: number;
  riskPerTrade: number;
  maxDailyLoss: number;
  maxWeeklyDrawdown: number;
  maxOpenPositions: number;
  cooldownMinutes: number;
  minRiskReward: number;
}

export interface ExecutionPlan {
  side: "BUY" | "SELL";
  action: TradeAction;
  entryType: TradeEntryType;
  leverage: number;
  quantity: number;
  notionalUsd: number;
  entryPrice: number;
  stopLoss?: number;
  tp1?: number;
  tp2?: number;
  breakEvenTriggerR?: number;
  trailingTriggerR?: number;
  trailingOffset?: number;
  initialRiskPerUnit?: number;
  maxHoldUntil?: number;
  confidence: number;
  setupType?: StrategySetupType;
  regimeAtEntry?: MarketRegime;
  entryReason: string;
  reasoningSummary: string;
  invalidationPrice?: number;
  reduceOnlyFraction?: number;
}

export interface RiskEvaluation {
  approved: boolean;
  reasons: string[];
  normalizedSignal: StrategySignal;
  executionPlan?: ExecutionPlan;
}

export interface EvaluationTrigger {
  reason: TriggerReason;
  priority: number;
  details: string;
  triggeredAt: number;
}

export interface ExecutionResult {
  tradeId: string;
  accepted: boolean;
  broker: string;
  message: string;
  positionState: PositionState;
  accountState: AccountState;
  tradeRecord?: PersistedTradeRecord;
  raw?: unknown;
}

export interface PersistedTradeRecord {
  tradeId: string;
  mode: TradingMode;
  action: TradeAction;
  side: "BUY" | "SELL";
  quantity: number;
  remainingQuantity: number;
  leverage: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  tp1?: number;
  tp2?: number;
  confidence: number;
  setupType?: StrategySetupType;
  status: string;
  entryReason: string;
  exitReason?: string;
  regimeAtEntry?: MarketRegime;
  entryFee: number;
  exitFee: number;
  grossPnl: number;
  netPnl: number;
  mfe: number;
  mae: number;
  openedAt: number;
  closedAt?: number;
  holdingMinutes?: number;
  details: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedDecisionRecord {
  decisionId: string;
  approved: boolean;
  mode: TradingMode;
  trigger: EvaluationTrigger;
  context: DecisionContext;
  signal: StrategySignal;
  plan?: ExecutionPlan;
  reasons: string[];
  createdAt: number;
}
