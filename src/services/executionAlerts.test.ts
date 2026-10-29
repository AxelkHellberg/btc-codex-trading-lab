import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import type { ExecutionResult, PersistedTradeRecord } from "../domain/types.js";
import type { TelegramNotifier } from "../infra/notifier/telegramNotifier.js";
import type { PostgresStateStore } from "../infra/store/postgresStateStore.js";
import type { Broker } from "./brokers.js";
import { ExecutionEngine } from "./executionEngine.js";
import { RuntimeState } from "./runtimeState.js";

function fixture(accepted = true) {
  const runtime = new RuntimeState(10_000);
  const record: PersistedTradeRecord = {
    tradeId: "fixture-trade", mode: "paper", action: "LONG", side: "BUY", quantity: 1,
    remainingQuantity: 1, leverage: 1, entryPrice: 100, confidence: 0.8, status: "open",
    entryReason: "fixture", entryFee: 0, exitFee: 0, grossPnl: 0, netPnl: 0, mfe: 0,
    mae: 0, openedAt: 1, details: { reasoning: "Recorded reasoning" }, createdAt: 1, updatedAt: 1
  };
  const result: ExecutionResult = {
    tradeId: record.tradeId, accepted, broker: "fixture", message: accepted ? "Entry accepted" : "Entry rejected",
    accountState: { ...runtime.getAccount(), availableBalance: 9_900 },
    positionState: { ...runtime.getPosition(), side: "long", quantity: 1 }, tradeRecord: record
  };
  const saveTrade = vi.fn().mockResolvedValue(undefined);
  const notify = vi.fn().mockResolvedValue(undefined);
  const execute = vi.fn();
  const logger = { error: vi.fn() };
  const engine = new ExecutionEngine(config, runtime, { saveTrade } as unknown as PostgresStateStore,
    { notify } as unknown as TelegramNotifier, { execute } as unknown as Broker, logger as unknown as Logger);
  return { engine, runtime, result, saveTrade, notify, execute, logger };
}

describe("accepted execution alerts", () => {
  it("still notifies exactly once when trade persistence fails, retaining the failure for callers", async () => {
    const f = fixture();
    const error = new Error("postgres://user:secret@internal");
    f.saveTrade.mockRejectedValueOnce(error);
    await expect(f.engine.handleExecutionResult(f.result)).rejects.toBe(error);
    expect(f.notify).toHaveBeenCalledExactlyOnceWith(
      "[paper] Entry accepted\nRecorded reasoning\nWarning: trade audit persistence failed."
    );
    expect(f.saveTrade).toHaveBeenCalledExactlyOnceWith(f.result.tradeRecord);
    expect(f.runtime.getAccount()).toEqual(f.result.accountState);
    expect(f.runtime.getPosition()).toEqual(f.result.positionState);
    expect(f.runtime.getRecentTrades()).toHaveLength(1);
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain("secret");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("keeps successful delivery unchanged", async () => {
    const f = fixture();
    await f.engine.handleExecutionResult(f.result);
    expect(f.notify).toHaveBeenCalledExactlyOnceWith("[paper] Entry accepted\nRecorded reasoning");
    expect(f.logger.error).not.toHaveBeenCalled();
  });

  it("never sends an accepted-execution alert for a rejected result", async () => {
    const f = fixture(false);
    f.saveTrade.mockRejectedValueOnce(new Error("write failed"));
    await expect(f.engine.handleExecutionResult(f.result)).rejects.toThrow("write failed");
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("reports both failures without replaying the broker, storage or notification", async () => {
    const f = fixture();
    const storageError = new Error("storage failed");
    const deliveryError = new Error("delivery failed");
    f.saveTrade.mockRejectedValueOnce(storageError);
    f.notify.mockRejectedValueOnce(deliveryError);
    const error = await f.engine.handleExecutionResult(f.result).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([storageError, deliveryError]);
    expect(f.saveTrade).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.logger.error).toHaveBeenCalledTimes(2);
  });

  it("surfaces a delivery failure after successful storage", async () => {
    const f = fixture();
    const error = new Error("delivery failed");
    f.notify.mockRejectedValueOnce(error);
    await expect(f.engine.handleExecutionResult(f.result)).rejects.toBe(error);
    expect(f.saveTrade).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it("uses fallback reasoning without requiring a trade record", async () => {
    const f = fixture();
    delete f.result.tradeRecord;
    await f.engine.handleExecutionResult(f.result, "Fallback reasoning");
    expect(f.saveTrade).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledExactlyOnceWith("[paper] Entry accepted\nFallback reasoning");
  });
});
