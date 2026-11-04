import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { DecisionContext, ExecutionPlan, PersistedTradeRecord } from "../domain/types.js";
import { PaperBroker } from "./brokers.js";
import { ExecutionEngine } from "./executionEngine.js";
import { RuntimeState } from "./runtimeState.js";
import { TradePersistenceQueue } from "./tradePersistenceQueue.js";

const logger = pino({ enabled: false });
const queues: TradePersistenceQueue[] = [];
function queue(write: (record: PersistedTradeRecord) => Promise<void>) {
  const result = new TradePersistenceQueue(write, logger); queues.push(result); return result;
}
const record = (revision = 1, tradeId = "trade"): PersistedTradeRecord => ({
  tradeId, revision, mode: "paper", action: "LONG", side: "BUY", quantity: .02, remainingQuantity: .02,
  leverage: 2, entryPrice: 100000, confidence: 1, status: "open", netPnl: 0, mfe: 0, mae: 0,
  entryReason: "test", entryFee: 0, exitFee: 0, grossPnl: 0, openedAt: 1,
  details: { message: "test" }, createdAt: 1, updatedAt: 1
});
afterEach(async () => {
  await Promise.all(queues.splice(0).map(item => item.stop().catch(() => {})));
  vi.useRealTimers();
});
describe("trade persistence retries", () => {
  it("repairs a real paper close after one failed write without executing another order", async () => {
    vi.useFakeTimers();
    const cfg = { ...config, paperStartingBalance: 10000, takerFeeBps: 0, slippageBps: 0 };
    const broker = new PaperBroker(cfg);
    const execute = vi.spyOn(broker, "execute");
    let stored: PersistedTradeRecord | undefined;
    const write = vi.fn(async (next: PersistedTradeRecord) => { stored = structuredClone(next); });
    const persistence = queue(write);
    const runtime = new RuntimeState(10000);
    const notify = vi.fn(async () => {});
    const engine = new ExecutionEngine(cfg, runtime, { saveTrade: write } as never, { notify } as never, broker, logger, persistence);
    const context = { market_snapshot: { symbol: "BTCUSDT", markPrice: 100000, filters: { tickSize: .1 } } } as DecisionContext;
    const plan: ExecutionPlan = { action: "LONG", side: "BUY", entryType: "MARKET", leverage: 2,
      quantity: .02, notionalUsd: 2000, entryPrice: 100000, stopLoss: 99000,
      confidence: 1, reasoningSummary: "regression", entryReason: "regression" };
    await engine.handleExecutionResult(await broker.execute(plan, context));
    expect(stored?.status).toBe("open");
    write.mockRejectedValueOnce(new Error("temporary outage"));
    const closed = await broker.onMarketSnapshot({ ...context.market_snapshot, markPrice: 98900 });
    expect(closed?.tradeRecord?.status).toBe("closed");
    await expect(engine.handleExecutionResult(closed!)).rejects.toThrow("temporary outage");
    expect(stored?.status).toBe("open");
    expect(persistence.status().pending).toBe(1);
    const walletAfterClose = broker.getState().accountState.walletBalance;
    await vi.advanceTimersByTimeAsync(1000);
    expect(stored).toEqual(closed!.tradeRecord);
    expect(stored?.netPnl).toBe(-22);
    expect(persistence.status().pending).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledTimes(2); // original open/close alerts only
    expect(broker.getState().accountState.walletBalance).toBe(walletAfterClose);
    expect(await broker.onMarketSnapshot(context.market_snapshot)).toBeNull();
    expect(write).toHaveBeenCalledTimes(3);
  });
  it("coalesces failed partial and duplicate records into the latest close", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (_: PersistedTradeRecord) => {}).mockRejectedValueOnce(new Error("offline"));
    const persistence = queue(write);
    await expect(persistence.save(record(2))).rejects.toThrow("offline");
    await expect(persistence.save(record(2))).rejects.toThrow("offline");
    expect(write).toHaveBeenCalledOnce();
    const closed = { ...record(3), status: "closed" as const, remainingQuantity: 0, netPnl: 12 };
    await persistence.save(closed);
    await vi.advanceTimersByTimeAsync(60000);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.at(-1)![0]).toEqual(closed);
    expect(persistence.status().pending).toBe(0);
  });
  it("serializes writes and never deletes a newer record queued during an older write", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const write = vi.fn(async (_: PersistedTradeRecord) => {});
    write.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
    const persistence = queue(write);
    const first = persistence.save(record(1)).catch(() => {});
    const next = persistence.save({ ...record(2), status: "closed" }).catch(() => {});
    expect(write).toHaveBeenCalledOnce();
    resolve();
    await Promise.all([first, next]);
    expect(persistence.status().pending).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1]![0].revision).toBe(2);
    expect(persistence.status().pending).toBe(0);
  });
  it("backs off prolonged failures to thirty seconds without dropping the pending trade", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => { throw new Error("offline"); });
    const persistence = queue(write);
    await expect(persistence.save(record())).rejects.toThrow("offline");
    let calls = 1;
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(write).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(write).toHaveBeenCalledTimes(++calls);
    }
    expect(persistence.status().pending).toBe(1);
  });
  it("copies accepted records so caller mutation cannot alter a retry", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (_: PersistedTradeRecord) => {}).mockRejectedValueOnce(new Error("offline"));
    const persistence = queue(write);
    const source = record();
    await expect(persistence.save(source)).rejects.toThrow();
    (source.details as { message: string }).message = "mutated";
    source.netPnl = 999;
    await vi.advanceTimersByTimeAsync(1000);
    expect(write.mock.calls[1]![0].details).toEqual({ message: "test" });
    expect(write.mock.calls[1]![0].netPnl).toBe(0);
  });
  it("retries other trades even when one trade remains broken", async () => {
    vi.useFakeTimers();
    let recover = false;
    const write = vi.fn(async (next: PersistedTradeRecord) => { if (next.tradeId === "bad" && !recover) throw new Error("offline"); });
    const persistence = queue(write);
    await expect(persistence.save(record(1, "bad"))).rejects.toThrow();
    await persistence.save(record(1, "good"));
    expect(persistence.status().pending).toBe(1);
    recover = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(persistence.status().pending).toBe(0);
  });
  it("flushes pending writes once on shutdown and cancels all future timers", async () => {
    vi.useFakeTimers();
    const write = vi.fn(async (_: PersistedTradeRecord) => {}).mockRejectedValueOnce(new Error("offline"));
    const persistence = queue(write);
    await expect(persistence.save(record())).rejects.toThrow();
    await persistence.stop();
    expect(write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60000);
    expect(write).toHaveBeenCalledTimes(2);
    await expect(persistence.save(record(2))).rejects.toThrow("stopping");
  });
  it("surfaces unpersisted shutdown records and retains their observable status", async () => {
    vi.useFakeTimers();
    const persistence = queue(async () => { throw new Error("offline"); });
    await expect(persistence.save(record())).rejects.toThrow("offline");
    await expect(persistence.stop()).rejects.toThrow("1 trade records remain unpersisted");
    expect(persistence.status().pending).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
