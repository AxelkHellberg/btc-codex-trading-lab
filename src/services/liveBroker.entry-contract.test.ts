import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import type { AccountState, DecisionContext, ExecutionPlan, PositionState } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { LiveBroker } from "./brokers.js";

const flat: PositionState = {
  side: "flat", quantity: 0, entryPrice: 0, markPrice: 0, leverage: 1,
  unrealizedPnl: 0, realizedPnl: 0
};
const account: AccountState = {
  equity: 10_000, walletBalance: 10_000, availableBalance: 9_000,
  dailyPnl: 0, weeklyDrawdown: 0, consecutiveLosses: 0, openOrders: 0, updatedAt: 1
};
const context = (position = flat): DecisionContext => ({ position_state: position } as DecisionContext);
const entryPlan = (action: "LONG" | "SHORT" = "LONG"): ExecutionPlan => ({
  action, side: action === "LONG" ? "BUY" : "SELL", entryType: "MARKET",
  leverage: 2, quantity: 0.02, notionalUsd: 2_000, entryPrice: 100_000,
  stopLoss: action === "LONG" ? 99_000 : 101_000,
  tp2: action === "LONG" ? 103_000 : 97_000,
  confidence: 0.7, setupType: "breakout", regimeAtEntry: "trend_up",
  entryReason: "Offline contract fixture", reasoningSummary: "Offline contract fixture"
});
const harness = () => {
  const client = {
    changeLeverage: vi.fn().mockResolvedValue(undefined),
    createOrder: vi.fn().mockResolvedValue({ orderId: 42 }),
    cancelAllOrders: vi.fn().mockResolvedValue(undefined),
    getBalanceState: vi.fn().mockResolvedValue(account),
    getPositionState: vi.fn().mockResolvedValue({ ...flat, side: "long", quantity: 0.019, entryPrice: 100_000 })
  };
  const broker = new LiveBroker({ ...config, tradingMode: "live" }, client as unknown as BinanceFuturesClient, {} as Logger);
  return { client, broker };
};

describe("LiveBroker offline order contracts", () => {
  it.each(["LONG", "SHORT"] as const)("places %s entry and opposite-side reduce-only protection", async (action) => {
    const { client, broker } = harness();
    const plan = entryPlan(action);
    const position = { ...flat, side: action === "LONG" ? "long" : "short", quantity: 0.019 };
    client.getPositionState.mockResolvedValue(position);
    const result = await broker.execute(plan, context());
    expect(client.changeLeverage).toHaveBeenCalledWith(config.symbol, 2);
    expect(client.createOrder).toHaveBeenCalledTimes(3);
    expect(client.createOrder).toHaveBeenNthCalledWith(1, expect.objectContaining({
      symbol: config.symbol, side: plan.side, type: "MARKET", quantity: 0.02, newOrderRespType: "RESULT"
    }));
    expect(client.createOrder).toHaveBeenNthCalledWith(2, expect.objectContaining({
      side: action === "LONG" ? "SELL" : "BUY", type: "STOP_MARKET", stopPrice: plan.stopLoss,
      quantity: 0.02, reduceOnly: true, workingType: "CONTRACT_PRICE"
    }));
    expect(client.createOrder).toHaveBeenNthCalledWith(3, expect.objectContaining({
      side: action === "LONG" ? "SELL" : "BUY", type: "TAKE_PROFIT_MARKET", stopPrice: plan.tp2,
      quantity: 0.02, reduceOnly: true, workingType: "CONTRACT_PRICE"
    }));
    expect(result).toMatchObject({ accepted: true, accountState: account, positionState: position });
    expect(result.tradeRecord).toMatchObject({ status: "open", quantity: 0.02, remainingQuantity: 0.019 });
    expect(client.getPositionState).toHaveBeenCalledWith(config.symbol);
    expect(client.getPositionState.mock.invocationCallOrder[0]).toBeGreaterThan(client.createOrder.mock.invocationCallOrder[2]!);
  });

  it("waits for leverage confirmation before submitting any order", async () => {
    const { client, broker } = harness();
    let confirm!: () => void;
    client.changeLeverage.mockImplementation(() => new Promise<void>((resolve) => { confirm = resolve; }));
    const pending = broker.execute(entryPlan(), context());
    expect(client.createOrder).not.toHaveBeenCalled();
    confirm();
    await pending;
    expect(client.createOrder).toHaveBeenCalledTimes(3);
  });

  it("does not place protection until the entry order is confirmed", async () => {
    const { client, broker } = harness();
    let confirm!: (order: { orderId: number }) => void;
    client.createOrder.mockImplementationOnce(() => new Promise((resolve) => { confirm = resolve; }));
    const pending = broker.execute(entryPlan(), context());
    await Promise.resolve();
    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(client.getBalanceState).not.toHaveBeenCalled();
    confirm({ orderId: 42 });
    await pending;
    expect(client.createOrder).toHaveBeenCalledTimes(3);
  });

  it.each(["leverage", "entry"] as const)("propagates a rejected %s without submitting later orders", async (stage) => {
    const { client, broker } = harness();
    const error = new Error("Synthetic exchange rejection");
    if (stage === "leverage") client.changeLeverage.mockRejectedValueOnce(error);
    else client.createOrder.mockRejectedValueOnce(error);
    await expect(broker.execute(entryPlan(), context())).rejects.toBe(error);
    expect(client.createOrder).toHaveBeenCalledTimes(stage === "leverage" ? 0 : 1);
    expect(client.getBalanceState).not.toHaveBeenCalled();
    expect(client.getPositionState).not.toHaveBeenCalled();
  });

});
