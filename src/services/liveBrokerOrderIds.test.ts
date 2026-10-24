import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type { DecisionContext, ExecutionPlan } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { LiveBroker } from "./brokers.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn((size: number) => actual.randomBytes(size)) };
});

const orderIdContract = /^[.A-Z:/a-z0-9_-]{1,36}$/;
const plan = (action: ExecutionPlan["action"]): ExecutionPlan => ({
  action, side: action === "LONG" ? "BUY" : "SELL", entryType: "MARKET",
  quantity: 0.02, leverage: 2, entryPrice: 100_000, stopLoss: 99_000, tp2: 103_000,
  notionalUsd: 2000, confidence: 0.8, setupType: "breakout",
  regimeAtEntry: "trend_up", entryReason: "fixture", reasoningSummary: "fixture"
});

function fixture(sourceTradeId?: string) {
  const position = { side: "long", quantity: 0.02, sourceTradeId };
  const client = {
    changeLeverage: vi.fn().mockResolvedValue({}),
    createOrder: vi.fn().mockImplementation(async (params) => ({ clientOrderId: params.newClientOrderId })),
    cancelAllOrders: vi.fn().mockResolvedValue({}),
    getBalanceState: vi.fn().mockResolvedValue({}),
    getPositionState: vi.fn().mockResolvedValue(position)
  };
  const broker = new LiveBroker(
    { symbol: "BTCUSDT", tradingMode: "live" } as AppConfig,
    client as unknown as BinanceFuturesClient,
    {} as Logger
  );
  const context = { position_state: position } as DecisionContext;
  return { broker, client, context };
}

describe("LiveBroker client order IDs", () => {
  it.each(["LONG", "SHORT", "CLOSE", "REDUCE"] as const)("validates generated IDs before any %s side effect", async (action) => {
    const { broker, client, context } = fixture("internal-id");
    // Inject an invalid generator result to exercise the preflight boundary.
    vi.mocked(randomBytes).mockReturnValueOnce(Buffer.alloc(32));
    await expect(broker.execute(plan(action), context)).rejects.toThrow("Invalid Binance client order ID");
    expect(client.changeLeverage).not.toHaveBeenCalled();
    expect(client.cancelAllOrders).not.toHaveBeenCalled();
    expect(client.createOrder).not.toHaveBeenCalled();
  });
  it.each(["LONG", "SHORT"] as const)("bounds entry and protection IDs for %s", async (action) => {
    const { broker, client, context } = fixture();
    const result = await broker.execute(plan(action), context);
    const ids = client.createOrder.mock.calls.map(([params]) => params.newClientOrderId);
    expect(ids).toHaveLength(3);
    expect(ids).toEqual([expect.stringMatching(/^entry-/), expect.stringMatching(/^stop-/), expect.stringMatching(/^tp-/)]);
    for (const id of ids) expect(id).toMatch(orderIdContract);
    expect(new Set(ids).size).toBe(3);
    expect(result.tradeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.tradeRecord?.tradeId).toBe(result.tradeId);
    expect(result.tradeRecord?.details.raw).toEqual({ clientOrderId: ids[0] });
  });

  it.each([undefined, "a".repeat(200), "external trade / id ? with unicode \u2603"])(
    "keeps internal correlation independent of exchange ID constraints (%s)", async (sourceTradeId) => {
      const { broker, client, context } = fixture(sourceTradeId);
      const result = await broker.execute(plan("LONG"), context);
      for (const [params] of client.createOrder.mock.calls) expect(params.newClientOrderId).toMatch(orderIdContract);
      if (sourceTradeId !== undefined) expect(result.tradeId).toBe(sourceTradeId);
      expect(result.tradeRecord?.tradeId).toBe(result.tradeId);
    }
  );

  it.each(["CLOSE", "REDUCE"] as const)("uses distinct valid IDs for repeated %s intents on one trade", async (action) => {
    const { broker, client, context } = fixture("external trade / id ? with unicode \u2603".repeat(4));
    const results = await Promise.all([broker.execute(plan(action), context), broker.execute(plan(action), context)]);
    const ids = client.createOrder.mock.calls.map(([params]) => params.newClientOrderId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^close-/);
      expect(id).toMatch(orderIdContract);
    }
    expect(results.map((result) => result.tradeId)).toEqual([context.position_state.sourceTradeId, context.position_state.sourceTradeId]);
  });
});
