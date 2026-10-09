import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  EvaluationTrigger,
  MarketSnapshot,
  PersistedDecisionRecord,
  PersistedTradeRecord
} from "../domain/types.js";
import { createHttpServer, type HttpServer } from "./server.js";
import { RuntimeState } from "../services/runtimeState.js";

const servers: HttpServer[] = [];

const marketSnapshot = (): MarketSnapshot => ({
  symbol: "BTCUSDT",
  markPrice: 100_500,
  indexPrice: 100_450,
  lastPrice: 100_480,
  bestBid: 100_499,
  bestAsk: 100_501,
  spreadBps: 0.2,
  fundingRate: 0.0001,
  nextFundingTime: Date.now() + 60_000,
  openInterest: 12,
  openInterestChangePct1m: 0.35,
  topTraderLongShortRatio: 1.2,
  volume1m: 12,
  priceChangePct1m: 0.25,
  priceChangePct5m: 0.8,
  priceChangePct15m: 1.1,
  priceChangePct1h: 2.4,
  intradayHigh: 100_900,
  intradayLow: 99_900,
  distanceFromIntradayHighPct: 0.4,
  distanceFromIntradayLowPct: 0.6,
  emaFast: 100_520,
  emaMedium: 100_210,
  trendStrengthPct: 0.32,
  volumeAcceleration: 1.6,
  timestamp: Date.now(),
  filters: {
    tickSize: 0.1,
    stepSize: 0.001,
    minQty: 0.001
  }
});

const trigger = (): EvaluationTrigger => ({
  reason: "manual_recheck",
  priority: 3,
  details: "manual test trigger",
  triggeredAt: Date.now()
});

const decisionRecord = (): PersistedDecisionRecord => ({
  decisionId: "decision-1",
  createdAt: Date.now(),
  approved: true,
  trigger: trigger(),
  context: {
    market_snapshot: marketSnapshot(),
    derivatives_snapshot: {
      funding_rate: 0.0001,
      next_funding_time: Date.now() + 60_000,
      open_interest: 12,
      open_interest_change_pct_1m: 0.35,
      top_trader_long_short_ratio: 1.2
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
      equity: 10_250,
      walletBalance: 10_250,
      availableBalance: 10_000,
      dailyPnl: 120,
      weeklyDrawdown: 0.01,
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
      momentum_score: 0.33,
      key_levels: {
        intraday_high: 100_900,
        intraday_low: 99_900
      },
      notes: ["dashboard smoke"]
    },
    trigger: trigger()
  },
  signal: {
    bias: "LONG",
    confidence: 0.78,
    setup_type: "breakout",
    take_profit: {
      type: "partial_ladder",
      levels: [
        { price: 101_400, size_pct: 0.5 },
        { price: 102_100, size_pct: 0.5 }
      ]
    },
    stop_loss: {
      type: "hard",
      price: 99_800
    },
    leverage: 2,
    reasoning_summary: "Momentum and open interest align.",
    key_risks: ["macro reversal"],
    invalidation: "Lose intraday support",
    sources: ["market"],
    order_preference: "MARKET",
    exit_if: {
      thesis_invalidated: true,
      momentum_reversal: true,
      risk_guardrail_hit: true,
      time_stop_minutes: 60
    }
  },
  plan: {
    action: "LONG",
    side: "BUY",
    entryType: "MARKET",
    leverage: 2,
    quantity: 0.01,
    notionalUsd: 1_005,
    entryPrice: 100_500,
    stopLoss: 99_800,
    tp1: 101_400,
    tp2: 102_100,
    breakEvenTriggerR: 1,
    trailingTriggerR: 2,
    trailingOffset: 400,
    initialRiskPerUnit: 700,
    maxHoldUntil: Date.now() + 60_000,
    confidence: 0.78,
    setupType: "breakout",
    regimeAtEntry: "trend_up",
    entryReason: "Momentum breakout",
    reasoningSummary: "Momentum breakout",
    invalidationPrice: 99_800
  },
  reasons: []
});

const tradeRecord = (): PersistedTradeRecord => ({
  tradeId: "trade-1",
  createdAt: Date.now(),
  action: "LONG",
  side: "BUY",
  quantity: 0.01,
  remainingQuantity: 0,
  leverage: 2,
  entryPrice: 100_500,
  stopLoss: 99_800,
  tp1: 101_400,
  tp2: 102_100,
  breakEvenTriggerR: 1,
  trailingTriggerR: 2,
  trailingOffset: 400,
  status: "closed",
  openedAt: Date.now() - 30_000,
  closedAt: Date.now(),
  exitPrice: 101_400,
  exitReason: "tp1",
  grossPnl: 9,
  fees: 1,
  netPnl: 8,
  mae: -3,
  mfe: 11,
  details: {
    message: "Partial ladder completed"
  }
});

async function buildServer(triggerEvaluation?: () => Promise<void>): Promise<HttpServer> {
  const runtime = new RuntimeState(10_000);
  runtime.setMarket(marketSnapshot());
  runtime.setAccount({
    equity: 10_250,
    walletBalance: 10_250,
    availableBalance: 10_000,
    dailyPnl: 120,
    weeklyDrawdown: 0.01,
    consecutiveLosses: 0,
    openOrders: 0,
    updatedAt: Date.now()
  });
  runtime.pushDecision(decisionRecord());
  runtime.upsertTrade(tradeRecord());

  const server = await createHttpServer(runtime, 0, triggerEvaluation);
  servers.push(server);
  return server;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.stop();
    }
  }
});

describe("createHttpServer", () => {
  it("serves the health check contract", async () => {
    const server = await buildServer();

    const response = await server.inject({
      method: "GET",
      url: "/healthz"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      ok: true,
      ts: expect.any(Number)
    });
  });

  it("serves the dashboard HTML shell", async () => {
    const server = await buildServer();

    const response = await server.inject({
      method: "GET",
      url: "/"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("<title>BTC Codex Trader</title>");
    expect(response.body).toContain("Trigger Now");
  });

  it("returns the runtime status payload", async () => {
    const server = await buildServer();

    const response = await server.inject({
      method: "GET",
      url: "/status"
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.market?.symbol).toBe("BTCUSDT");
    expect(body.account?.equity).toBe(10_250);
    expect(body.position?.side).toBe("flat");
    expect(body.tradeStats?.realizedPnl).toBe(8);
    expect(body.recentDecisions).toHaveLength(1);
    expect(body.recentTrades).toHaveLength(1);
  });

  it("triggers a manual evaluation when configured", async () => {
    const triggerEvaluation = vi.fn(async () => {});
    const server = await buildServer(triggerEvaluation);

    const response = await server.inject({
      method: "POST",
      url: "/trigger"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(triggerEvaluation).toHaveBeenCalledTimes(1);
  });

  it("surfaces trigger failures as a server error", async () => {
    const server = await buildServer(async () => {
      throw new Error("manual trigger failed");
    });

    const response = await server.inject({
      method: "POST",
      url: "/trigger"
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: "Internal Server Error",
      message: "manual trigger failed",
      statusCode: 500
    });
  });
});
