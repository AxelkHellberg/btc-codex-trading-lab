import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { DecisionContext, ExecutionPlan, PersistedTradeRecord } from "../domain/types.js";
import { PaperBroker, LiveBroker } from "./brokers.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { PostgresStateStore } from "../infra/store/postgresStateStore.js";

const plan: ExecutionPlan = { action: "LONG", side: "BUY", entryType: "MARKET", leverage: 2, quantity: 0.02, notionalUsd: 2_000, entryPrice: 100_000, stopLoss: 99_000, tp1: 101_500, tp2: 103_000, breakEvenTriggerR: 1, trailingTriggerR: 2, trailingOffset: 1_000, initialRiskPerUnit: 1_000, maxHoldUntil: 999_999_999, confidence: 0.8, setupType: "breakout", regimeAtEntry: "trend_up", entryReason: "test", reasoningSummary: "test", invalidationPrice: 99_000 };
const market = { symbol: "BTCUSDT", markPrice: 100_000, bestAsk: 100_000, bestBid: 100_000, filters: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001 }, timestamp: 10_000 };
const context = { market_snapshot: market, position_state: { side: "flat", quantity: 0 } } as DecisionContext;
afterEach(() => vi.restoreAllMocks());
describe("broker trade revision contract", () => {
  it("increments paper open/partial/closed revisions even with one wall-clock timestamp", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const broker = new PaperBroker({ ...config, takerFeeBps: 0, slippageBps: 0 });
    const opened = await broker.execute(plan, context);
    const partial = await broker.execute({ ...plan, action: "REDUCE", side: "SELL", quantity: 0.01 }, context);
    const closed = await broker.execute({ ...plan, action: "CLOSE", side: "SELL", quantity: 0.01 }, context);
    expect([opened, partial, closed].map(r => r.tradeRecord?.revision)).toEqual([1, 2, 3]);
    expect(new Set([opened, partial, closed].map(r => r.tradeRecord?.updatedAt)).size).toBe(1);
    expect(opened.tradeRecord?.revision).toBe(1);
    expect(closed.tradeRecord?.status).toBe("closed");
  });
  it("increments live revisions without real exchange calls", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    let quantity = 0.02;
    const client = { changeLeverage: vi.fn().mockResolvedValue(undefined), createOrder: vi.fn().mockResolvedValue({}), cancelAllOrders: vi.fn().mockResolvedValue(undefined),
      getBalanceState: vi.fn().mockResolvedValue({}), getPositionState: vi.fn(() => Promise.resolve({ quantity })) };
    const broker = new LiveBroker({ ...config, tradingMode: "live" }, client as unknown as BinanceFuturesClient, pino({ enabled: false }));
    const opened = await broker.execute(plan, context);
    quantity = 0.01;
    const partial = await broker.execute({ ...plan, action: "REDUCE", side: "SELL", quantity: 0.01 }, context);
    quantity = 0;
    const closed = await broker.execute({ ...plan, action: "CLOSE", side: "SELL", quantity: 0.01 }, context);
    expect([opened, partial, closed].map(r => r.tradeRecord?.revision)).toEqual([1, 2, 3]);
  });
  it.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid revision %s before SQL", async revision => {
    const store = new PostgresStateStore("postgres://unused", pino({ enabled: false }));
    await expect(store.saveTrade({ revision } as PersistedTradeRecord)).rejects.toThrow("positive safe integer");
    await store.close();
  });
});
