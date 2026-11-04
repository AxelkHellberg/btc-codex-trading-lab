import { describe, expect, it, vi } from "vitest";
import pino from "pino";
import { config } from "../config.js";
import type { DecisionContext, ExecutionPlan } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { LiveBroker, PaperBroker, type Broker } from "./brokers.js";

const context = (): DecisionContext => ({
  market_snapshot: {
    symbol: "BTCUSDT",
    markPrice: 100_000,
    indexPrice: 100_000,
    lastPrice: 100_000,
    bestBid: 100_000,
    bestAsk: 100_001,
    spreadBps: 0.1,
    fundingRate: 0.0001,
    nextFundingTime: Date.now() + 60_000,
    openInterest: 10,
    openInterestChangePct1m: 0.1,
    topTraderLongShortRatio: 1.1,
    volume1m: 1,
    priceChangePct1m: 0.1,
    priceChangePct5m: 0.3,
    priceChangePct15m: 0.6,
    priceChangePct1h: 1.1,
    intradayHigh: 100800,
    intradayLow: 99200,
    distanceFromIntradayHighPct: 0.7,
    distanceFromIntradayLowPct: 0.8,
    emaFast: 100120,
    emaMedium: 99970,
    trendStrengthPct: 0.15,
    volumeAcceleration: 1.2,
    timestamp: Date.now(),
    filters: {
      tickSize: 0.1,
      stepSize: 0.001,
      minQty: 0.001
    }
  },
  derivatives_snapshot: {
    funding_rate: 0.0001,
    next_funding_time: Date.now() + 60_000,
    open_interest: 10,
    open_interest_change_pct_1m: 0.1,
    top_trader_long_short_ratio: 1.1
  },
  news_events: [],
  onchain_snapshot: null,
  position_state: {
    side: "flat",
    quantity: 0,
    entryPrice: 0,
    markPrice: 0,
    leverage: 1,
    unrealizedPnl: 0,
    realizedPnl: 0
  },
  account_state: {
    equity: 10_000,
    walletBalance: 10_000,
    availableBalance: 10_000,
    dailyPnl: 0,
    weeklyDrawdown: 0,
    consecutiveLosses: 0,
    openOrders: 0,
    updatedAt: Date.now()
  },
  risk_state: {
    withinDailyLossLimit: true,
    withinWeeklyDrawdown: true,
    cooldownActive: false,
    reasons: []
  },
  context_summary: {
    regime: "trend_up",
    trend_bias: "bullish",
    catalyst_bias: "neutral",
    momentum_score: 0.31,
    key_levels: {
      intraday_high: 100800,
      intraday_low: 99200
    },
    notes: ["test"]
  },
  trigger: {
    reason: "minute_recheck",
    priority: 0,
    details: "test",
    triggeredAt: Date.now()
  }
});

describe("broker snapshot capabilities", () => {
  it("does not let a generic synchronous state reader replace live values with placeholders", () => {
    const live: Broker = new LiveBroker(config, {} as BinanceFuturesClient, pino({ level: "silent" }));
    const previous = context();
    const state = live.getState?.() ?? {
      accountState: previous.account_state, positionState: { ...previous.position_state, side: "long", quantity: 0.02 }
    };
    expect(state.accountState.equity).toBe(10_000);
    expect(state.positionState.side).toBe("long");
    expect(state.positionState.quantity).toBe(0.02);
  });

  it("still returns exchange-backed state from an asynchronous live execution", async () => {
    const accountState = { ...context().account_state, equity: 12_000 };
    const positionState = { ...context().position_state, side: "long" as const, quantity: 0.02, entryPrice: 100_000 };
    const client = {
      changeLeverage: vi.fn().mockResolvedValue(undefined),
      createOrder: vi.fn().mockResolvedValue({ orderId: 123 }),
      getBalanceState: vi.fn().mockResolvedValue(accountState),
      getPositionState: vi.fn().mockResolvedValue(positionState)
    };
    const live = new LiveBroker(config, client as unknown as BinanceFuturesClient, pino({ level: "silent" }));
    const result = await live.execute({
      action: "LONG", side: "BUY", entryType: "MARKET", quantity: 0.02, leverage: 2,
      entryPrice: 100_000, notionalUsd: 2_000, confidence: 0.8,
      entryReason: "contract fixture", reasoningSummary: "contract fixture"
    }, context());
    expect(result.accepted).toBe(true);
    expect(result.accountState).toEqual(accountState);
    expect(result.positionState).toEqual(positionState);
    expect(client.createOrder).toHaveBeenCalledTimes(1);
  });

  it("keeps paper synchronous snapshots detached from broker-owned balances and positions", async () => {
    const paper: Broker = new PaperBroker({ ...config, paperStartingBalance: 10_000 });
    const state = paper.getState!();
    state.accountState.walletBalance = 0;
    state.positionState.quantity = 99;
    expect(paper.getState!().accountState.walletBalance).toBe(10_000);
    expect(paper.getState!().positionState.quantity).toBe(0);
  });
});
