import { describe, expect, it } from "vitest";

import type { PersistedTradeRecord } from "../domain/types.js";
import { RuntimeState } from "./runtimeState.js";

function trade(tradeId: string, status: string, netPnl: number): PersistedTradeRecord {
  return {
    tradeId, status, netPnl, mode: "paper", action: "LONG", side: "BUY",
    quantity: 1, remainingQuantity: status === "closed" ? 0 : 0.5,
    leverage: 1, entryPrice: 100, confidence: 0.8, entryReason: "fixture",
    entryFee: 0.1, exitFee: 0.1, grossPnl: netPnl + 0.2, mfe: 4, mae: -2,
    openedAt: 1, createdAt: 1, updatedAt: 2, details: {}
  };
}

describe("realized trade statistics", () => {
  it.each([12, -7])("includes a partial exit's cumulative realized PnL (%s)", (netPnl) => {
    const runtime = new RuntimeState(1_000);
    runtime.upsertTrade(trade("partial", "partial", netPnl));
    expect(runtime.getTradeStats()).toMatchObject({
      realizedPnl: netPnl, winRate: 0, expectancy: 0, averageWinner: 0,
      averageLoser: 0, averageMfe: 0, averageMae: 0, exitDistribution: {}
    });
  });

  it("combines partial and closed PnL while keeping outcome metrics closed-only", () => {
    const runtime = new RuntimeState(1_000);
    runtime.upsertTrade({ ...trade("closed", "closed", 10), exitReason: "take_profit" });
    runtime.upsertTrade(trade("partial", "partial", -4));
    runtime.upsertTrade(trade("open", "open", -0.1));
    expect(runtime.getTradeStats()).toMatchObject({
      realizedPnl: 6, winRate: 1, expectancy: 10,
      averageWinner: 10, averageLoser: 0, averageMfe: 4, averageMae: -2,
      exitDistribution: { take_profit: 1 }
    });
  });

  it("replaces cumulative partial updates and the final close without counting either twice", () => {
    const runtime = new RuntimeState(1_000);
    runtime.upsertTrade(trade("same", "partial", 5));
    runtime.upsertTrade(trade("same", "partial", 8));
    expect(runtime.getTradeStats().realizedPnl).toBe(8);
    runtime.upsertTrade({ ...trade("same", "closed", 11), exitReason: "manual" });
    expect(runtime.getRecentTrades()).toHaveLength(1);
    expect(runtime.getTradeStats()).toMatchObject({ realizedPnl: 11, winRate: 1, expectancy: 11, exitDistribution: { manual: 1 } });
  });
});
