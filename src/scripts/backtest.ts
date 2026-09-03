import { config } from "../config.js";
import type { DecisionContext, StrategySignal } from "../domain/types.js";
import { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { logger } from "../logger.js";
import { PaperBroker } from "../services/brokers.js";
import { RiskEngine } from "../services/riskEngine.js";
import { StrategyPlanner } from "../services/strategyPlanner.js";

type Kline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

type Candle = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

const {
  backtest: { days, initialBalance }
} = config;

const ema = (values: number[], period: number): number => {
  const k = 2 / (period + 1);
  let current = values[0] ?? 0;
  for (const value of values.slice(1)) {
    current = value * k + current * (1 - k);
  }
  return current;
};

const average = (values: number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const changePct = (current: number, reference: number | undefined): number =>
  reference && reference !== 0 ? ((current - reference) / reference) * 100 : 0;

const volumeAcceleration = (candles: Candle[]): number => {
  const recent = average(candles.slice(-5).map((candle) => candle.volume));
  const baseline = average(candles.slice(-20, -5).map((candle) => candle.volume));
  if (baseline <= 0) {
    return recent > 0 ? 1 : 0;
  }
  return recent / baseline;
};

const fetchHistoricalKlines = async (
  client: BinanceFuturesClient,
  symbol: string,
  startTime: number,
  endTime: number
): Promise<Candle[]> => {
  const rows: Candle[] = [];
  let cursor = startTime;

  while (cursor < endTime) {
    const url = `${config.binance.restBaseUrl}/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=1500&startTime=${cursor}&endTime=${endTime}`;
    const response = (await fetch(url).then((res) => res.json())) as Kline[];
    if (response.length === 0) {
      break;
    }

    const candles = response.map((row) => ({
      openTime: row[0],
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: row[6]
    }));
    rows.push(...candles);
    cursor = candles[candles.length - 1]!.closeTime + 1;
    if (response.length < 1500) {
      break;
    }
  }

  return rows;
};

const decideFromHistory = (candles: Candle[]): StrategySignal => {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volume);
  const current = candles[candles.length - 1]!;
  const emaFast = ema(closes.slice(-20), 20);
  const emaSlow = ema(closes.slice(-50), 50);
  const ret5 = ((current.close - candles[candles.length - 6]!.close) / candles[candles.length - 6]!.close) * 100;
  const volAvg = average(volumes.slice(-20));
  const volNow = current.volume;
  const stopDistance = current.close * 0.0055;

  if (current.close > emaFast && emaFast > emaSlow && ret5 > 0.35 && volNow > volAvg * 1.15) {
    return {
      bias: "LONG",
      confidence: 0.68,
      setup_type: "breakout",
      invalidation_price: current.close - stopDistance,
      holding_horizon_minutes: 180,
      reasoning_summary: "Historical bullish breakout with trend alignment and volume confirmation."
    };
  }

  if (current.close < emaFast && emaFast < emaSlow && ret5 < -0.35 && volNow > volAvg * 1.15) {
    return {
      bias: "SHORT",
      confidence: 0.68,
      setup_type: "breakout",
      invalidation_price: current.close + stopDistance,
      holding_horizon_minutes: 180,
      reasoning_summary: "Historical downside breakout with trend alignment and volume confirmation."
    };
  }

  return {
    bias: "FLAT",
    confidence: 0.45,
    setup_type: "continuation",
    invalidation_price: undefined,
    holding_horizon_minutes: 60,
    reasoning_summary: "No clean momentum setup in the replay window."
  };
};

const main = async (): Promise<void> => {
  const client = new BinanceFuturesClient(
    config.binance.restBaseUrl,
    config.binance.wsBaseUrl,
    "",
    "",
    logger
  );
  const broker = new PaperBroker({
    ...config,
    paperStartingBalance: initialBalance,
    tradingMode: "paper"
  });
  const planner = new StrategyPlanner(config);
  const riskEngine = new RiskEngine(config);
  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  const candles = await fetchHistoricalKlines(client, config.symbol, startTime, endTime);
  const filters = await client.getSymbolFilters(config.symbol);
  let wins = 0;
  let losses = 0;
  let entries = 0;
  let exits = 0;
  let peakEquity = initialBalance;
  let maxDrawdown = 0;

  for (let index = 60; index < candles.length; index += 1) {
    const window = candles.slice(Math.max(0, index - 60), index + 1);
    const current = window[window.length - 1]!;
    const closes = window.map((candle) => candle.close);
    const intradayWindow = window.slice(-Math.min(window.length, 24 * 60));
    const intradayHigh = Math.max(...intradayWindow.map((candle) => candle.high));
    const intradayLow = Math.min(...intradayWindow.map((candle) => candle.low));
    const emaFast = ema(closes.slice(-9), 9);
    const emaMedium = ema(closes.slice(-21), 21);
    const marketSnapshot = {
      symbol: config.symbol,
      markPrice: current.close,
      indexPrice: current.close,
      lastPrice: current.close,
      bestBid: current.close,
      bestAsk: current.close,
      spreadBps: 0.1,
      fundingRate: 0,
      nextFundingTime: current.closeTime + 8 * 60 * 60 * 1000,
      openInterest: 0,
      openInterestChangePct1m: 0,
      topTraderLongShortRatio: 1,
      volume1m: current.volume,
      priceChangePct1m: changePct(current.close, window[window.length - 2]?.close),
      priceChangePct5m: changePct(current.close, window[Math.max(0, window.length - 6)]?.close),
      priceChangePct15m: changePct(current.close, window[Math.max(0, window.length - 16)]?.close),
      priceChangePct1h: changePct(current.close, window[Math.max(0, window.length - 61)]?.close),
      intradayHigh,
      intradayLow,
      distanceFromIntradayHighPct: changePct(current.close, intradayHigh),
      distanceFromIntradayLowPct: changePct(current.close, intradayLow),
      emaFast,
      emaMedium,
      trendStrengthPct: emaMedium !== 0 ? ((emaFast - emaMedium) / emaMedium) * 100 : 0,
      volumeAcceleration: volumeAcceleration(window),
      timestamp: current.closeTime,
      filters
    };
    const paperState = await broker.onMarketSnapshot?.(marketSnapshot);
    if (paperState?.accepted && paperState.tradeRecord?.status === "closed") {
      exits += 1;
      const netPnl = paperState.tradeRecord.netPnl;
      if (netPnl >= 0) {
        wins += 1;
      } else {
        losses += 1;
      }
    }
    const snapshotState = broker.getState?.();

    const context: DecisionContext = {
      market_snapshot: marketSnapshot,
      derivatives_snapshot: {
        funding_rate: 0,
        next_funding_time: marketSnapshot.nextFundingTime,
        open_interest: 0,
        open_interest_change_pct_1m: 0,
        top_trader_long_short_ratio: 1
      },
      news_events: [],
      onchain_snapshot: null,
      position_state: snapshotState?.positionState ?? {
        side: "flat",
        quantity: 0,
        entryPrice: 0,
        markPrice: 0,
        leverage: 1,
        unrealizedPnl: 0,
        realizedPnl: 0
      },
      account_state: snapshotState?.accountState ?? {
        equity: initialBalance,
        walletBalance: initialBalance,
        availableBalance: initialBalance,
        dailyPnl: 0,
        weeklyDrawdown: 0,
        consecutiveLosses: 0,
        openOrders: 0,
        updatedAt: current.closeTime
      },
      risk_state: {
        withinDailyLossLimit: true,
        withinWeeklyDrawdown: true,
        cooldownActive: false,
        reasons: []
      },
      context_summary: {
        regime:
          marketSnapshot.emaFast > marketSnapshot.emaMedium &&
          marketSnapshot.priceChangePct15m >= 0.2 &&
          marketSnapshot.priceChangePct1h >= 0.6
            ? "trend_up"
            : marketSnapshot.emaFast < marketSnapshot.emaMedium &&
                marketSnapshot.priceChangePct15m <= -0.2 &&
                marketSnapshot.priceChangePct1h <= -0.6
              ? "trend_down"
              : Math.abs(marketSnapshot.priceChangePct5m) < 0.18 && Math.abs(marketSnapshot.trendStrengthPct) < 0.14
                ? "range"
                : "transition",
        trend_bias:
          marketSnapshot.emaFast > marketSnapshot.emaMedium
            ? "bullish"
            : marketSnapshot.emaFast < marketSnapshot.emaMedium
              ? "bearish"
              : "neutral",
        catalyst_bias: "neutral",
        momentum_score: Number(
          (
            marketSnapshot.priceChangePct1m * 0.2 +
            marketSnapshot.priceChangePct5m * 0.35 +
            marketSnapshot.priceChangePct15m * 0.2 +
            marketSnapshot.trendStrengthPct * 10 * 0.15 +
            (marketSnapshot.volumeAcceleration - 1) * 100 * 0.1
          ).toFixed(2)
        ),
        key_levels: {
          intraday_high: intradayHigh,
          intraday_low: intradayLow
        },
        notes: [
          `EMA9=${emaFast.toFixed(2)} EMA21=${emaMedium.toFixed(2)}`,
          `volAccel=${marketSnapshot.volumeAcceleration.toFixed(2)}x`
        ]
      },
      trigger: {
        reason: "minute_recheck",
        priority: 0,
        details: "historical replay",
        triggeredAt: current.closeTime
      }
    };

    if (context.position_state.side === "flat") {
      const signal = decideFromHistory(window);
      const planning = planner.plan(context, signal);
      const evaluation = riskEngine.evaluate(context, planning);
      if (evaluation.approved && evaluation.executionPlan) {
        const open = await broker.execute(evaluation.executionPlan, context);
        if (open.accepted) {
          entries += 1;
        }
      }
    }

    const equity = broker.getState?.().accountState.equity ?? initialBalance;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0);
  }

  logger.info(
    {
      symbol: config.symbol,
      days,
      entries,
      exits,
      wins,
      losses,
      winRate: exits > 0 ? wins / exits : 0,
      maxDrawdown
    },
    "Backtest completed"
  );
};

void main().catch((error) => {
  logger.error({ error }, "Backtest failed");
  process.exit(1);
});
