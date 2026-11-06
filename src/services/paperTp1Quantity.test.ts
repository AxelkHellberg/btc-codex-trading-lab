import { describe, expect, it } from "vitest";
import { config } from "../config.js";
import type { DecisionContext, ExecutionPlan, MarketSnapshot } from "../domain/types.js";
import { PaperBroker } from "./brokers.js";

const snapshot = (markPrice = 100): MarketSnapshot => ({
  markPrice, timestamp: Date.now(), filters: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001 }
} as MarketSnapshot);
const open = async (quantity: number, side: "BUY" | "SELL" = "BUY") => {
  const broker = new PaperBroker({ ...config, slippageBps: 0, takerFeeBps: 0 });
  await broker.execute({ action: side === "BUY" ? "LONG" : "SHORT", side, quantity,
    leverage: 2, entryType: "MARKET", entryPrice: 100, tp1: side === "BUY" ? 110 : 90,
    tp2: side === "BUY" ? 120 : 80, stopLoss: side === "BUY" ? 80 : 120,
    confidence: 1, notionalUsd: quantity * 100
  } as ExecutionPlan, { market_snapshot: snapshot() } as DecisionContext);
  return broker;
};
describe("executable automatic TP1 quantities", () => {
  it.each(["BUY", "SELL"] as const)("skips a below-minimum partial for %s and still honors TP2", async (side) => {
    const broker = await open(0.001, side);
    expect(await broker.onMarketSnapshot(snapshot(side === "BUY" ? 110 : 90))).toBeNull();
    expect(broker.getState().positionState.quantity).toBe(0.001);
    expect((await broker.onMarketSnapshot(snapshot(side === "BUY" ? 120 : 80)))?.positionState.side).toBe("flat");
  });
  it("rounds an odd lot down while leaving an executable remainder", async () => {
    const broker = await open(0.003);
    const result = await broker.onMarketSnapshot(snapshot(110));
    expect(result?.tradeRecord?.remainingQuantity).toBeCloseTo(0.002);
    expect(result?.positionState.tp1Filled).toBe(true);
    expect(await broker.onMarketSnapshot(snapshot(111))).toBeNull();
    expect(broker.getState().positionState.quantity).toBeCloseTo(0.002);
  });
  it("supports non-power-of-ten steps", async () => {
    const broker = await open(0.875);
    const market = snapshot(110);
    market.filters = { tickSize: 0.1, stepSize: 0.125, minQty: 0.125 };
    expect((await broker.onMarketSnapshot(market))?.positionState.quantity).toBe(0.5);
  });
  it("does not strand a remainder below minQty", async () => {
    const broker = await open(0.003);
    const market = snapshot(110);
    market.filters!.minQty = 0.002;
    expect(await broker.onMarketSnapshot(market)).toBeNull();
    expect(broker.getState().positionState.quantity).toBe(0.003);
  });
  it.each([undefined, { tickSize: 0.1, stepSize: 0, minQty: 0.001 },
    { tickSize: 0.1, stepSize: 0.001, minQty: NaN }])("skips unverified quantity filters %j", async (filters) => {
    const broker = await open(0.003);
    expect(await broker.onMarketSnapshot({ ...snapshot(110), filters })).toBeNull();
    expect(broker.getState().positionState.quantity).toBe(0.003);
    expect((await broker.onMarketSnapshot({ ...snapshot(70), filters }))?.positionState.side).toBe("flat");
  });
});
