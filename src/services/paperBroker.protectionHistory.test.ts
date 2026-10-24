import { describe, expect, it } from "vitest";

import type { AppConfig } from "../config.js";
import type { DecisionContext, ExecutionPlan, MarketSnapshot } from "../domain/types.js";
import { PaperBroker } from "./brokers.js";

const market = (markPrice = 100_000): MarketSnapshot => ({
  symbol: "BTCUSDT", markPrice, filters: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001 }
} as MarketSnapshot);
const plan = (short = false): ExecutionPlan => ({
  action: short ? "SHORT" : "LONG", side: short ? "SELL" : "BUY", entryType: "MARKET",
  leverage: 2, quantity: 0.02, notionalUsd: 2_000, entryPrice: 100_000,
  stopLoss: short ? 101_000 : 99_000, tp1: short ? 98_500 : 101_500,
  tp2: short ? 97_000 : 103_000, initialRiskPerUnit: 1_000,
  breakEvenTriggerR: 1, trailingTriggerR: 2, trailingOffset: 1_000,
  confidence: 0.8, setupType: "breakout", regimeAtEntry: "trend_up",
  entryReason: "fixture", reasoningSummary: "fixture"
});
const setup = async (entry = plan()) => {
  const broker = new PaperBroker({ paperStartingBalance: 10_000, slippageBps: 0, takerFeeBps: 0 } as AppConfig);
  const context = { market_snapshot: market() } as DecisionContext;
  const open = await broker.execute(entry, context);
  return { broker, open, context };
};

describe("closed paper trade protection history", () => {
  it("keeps all protection levels on a direct full close while flattening the position", async () => {
    const { broker, open, context } = await setup();
    const result = await broker.execute({ ...plan(), action: "CLOSE", side: "SELL" }, context);
    expect(result.tradeRecord).toMatchObject({
      status: "closed", remainingQuantity: 0,
      stopLoss: 99_000, takeProfit: 103_000, tp1: 101_500, tp2: 103_000
    });
    expect(result.positionState).toMatchObject({ side: "flat", quantity: 0 });
    expect(result.positionState.stopLoss).toBeUndefined();
    expect(open.tradeRecord?.status).toBe("open");
  });

  it.each([false, true])("retains protection after a stop-loss exit (short=%s)", async (short) => {
    const { broker } = await setup(plan(short));
    const result = await broker.onMarketSnapshot(market(short ? 101_100 : 98_900));
    expect(result?.tradeRecord).toMatchObject({
      status: "closed", exitReason: "stop_loss", remainingQuantity: 0,
      stopLoss: short ? 101_000 : 99_000, tp1: short ? 98_500 : 101_500,
      tp2: short ? 97_000 : 103_000, takeProfit: short ? 97_000 : 103_000
    });
    expect(result?.positionState.side).toBe("flat");
  });

  it("retains the latest trailing stop after a partial take profit and final exit", async () => {
    const { broker } = await setup();
    const partial = await broker.onMarketSnapshot(market(101_600));
    expect(partial?.tradeRecord?.status).toBe("partial");
    await broker.onMarketSnapshot(market(102_200));
    const tightenedStop = broker.getState().positionState.stopLoss;
    expect(tightenedStop).toBe(101_200);
    const result = await broker.onMarketSnapshot(market(101_100));
    expect(result?.tradeRecord).toMatchObject({
      status: "closed", exitReason: "trailing_stop", remainingQuantity: 0,
      stopLoss: tightenedStop, takeProfit: 103_000, tp1: 101_500, tp2: 103_000
    });
    expect(result?.positionState.side).toBe("flat");
  });

  it("does not invent levels for an entry without protection", async () => {
    const { broker, context } = await setup({ ...plan(), stopLoss: undefined, tp1: undefined, tp2: undefined });
    const result = await broker.execute({ ...plan(), action: "CLOSE", side: "SELL" }, context);
    expect(result.tradeRecord?.status).toBe("closed");
    for (const key of ["stopLoss", "takeProfit", "tp1", "tp2"] as const) {
      expect(result.tradeRecord?.[key]).toBeUndefined();
    }
  });
});
