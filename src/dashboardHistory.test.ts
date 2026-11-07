import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedDecisionRecord, PersistedTradeRecord } from "./domain/types.js";
import type { RuntimeState } from "./services/runtimeState.js";

const mocks = vi.hoisted(() => ({ init: vi.fn(), load: vi.fn(), http: vi.fn(), marketStart: vi.fn(), error: vi.fn(), info: vi.fn(), signals: new Map<string, () => void>() }));
vi.mock("./logger.js", () => ({ logger: { error: mocks.error, info: mocks.info } }));
vi.mock("./infra/store/postgresStateStore.js", () => ({ PostgresStateStore: class { init = mocks.init; loadRecentHistory = mocks.load; close = async () => {}; } }));
vi.mock("./infra/store/redisHotStore.js", () => ({ RedisHotStore: class { close = async () => {}; } }));
vi.mock("./http/server.js", () => ({ createHttpServer: mocks.http }));
vi.mock("./services/marketIngestor.js", () => ({ MarketIngestor: class { start = mocks.marketStart; stop = async () => {}; } }));
vi.mock("./services/newsIngestor.js", () => ({ NewsIngestor: class { start = async () => {}; stop = () => {}; } }));
vi.mock("./services/onchainIngestor.js", () => ({ OnchainIngestor: class { start = async () => {}; stop = () => {}; } }));
vi.mock("./services/codexDecisionWorker.js", () => ({ CodexDecisionWorker: class {} }));

let started = false;
beforeEach(() => {
  vi.resetModules(); started = false; mocks.signals.clear();
  for (const fn of [mocks.init, mocks.load, mocks.http, mocks.marketStart, mocks.error, mocks.info]) fn.mockReset();
  mocks.init.mockResolvedValue(undefined); mocks.load.mockResolvedValue({ decisions: [], trades: [] });
  mocks.http.mockResolvedValue({ start: async () => { started = true; }, stop: async () => {} });
  const original = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...args: any[]) => void) => {
    if (event === "SIGINT" || event === "SIGTERM") { mocks.signals.set(event, listener); return process; }
    return original(event as never, listener);
  }) as typeof process.on);
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});
afterEach(async () => {
  if (started) { mocks.signals.get("SIGTERM")!(); await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0)); }
  vi.restoreAllMocks();
});
const trade = (id: string, pnl: number, at: number): PersistedTradeRecord => ({
  tradeId: id, mode: "paper", action: "LONG", side: "BUY", quantity: 1, remainingQuantity: 0,
  leverage: 1, entryPrice: 100, confidence: 0.8, status: "closed", entryReason: "test",
  entryFee: 1, exitFee: 1, grossPnl: pnl + 2, netPnl: pnl, mfe: 2, mae: -1,
  openedAt: at - 100, closedAt: at, createdAt: at - 100, updatedAt: at, details: { nested: null }
});
const decision = (id: string, at: number) => ({ decisionId: id, createdAt: at }) as PersistedDecisionRecord;
describe("dashboard history startup", () => {
  it("restores newest-first history and sampled stats before HTTP, leaving broker state untouched", async () => {
    mocks.load.mockResolvedValue({ decisions: [decision("new", 20), decision("old", 10)], trades: [trade("winner", 20, 20), trade("loser", -5, 10)] });
    await import("./index.js"); await vi.waitFor(() => expect(started).toBe(true));
    const runtime = mocks.http.mock.calls[0]![0] as RuntimeState;
    expect(runtime.getRecentDecisions().map(d => d.decisionId)).toEqual(["new", "old"]);
    expect(runtime.getRecentTrades().map(t => t.tradeId)).toEqual(["winner", "loser"]);
    expect(runtime.getTradeStats()).toMatchObject({ realizedPnl: 15, winRate: 0.5, expectancy: 7.5 });
    expect(runtime.getPosition().side).toBe("flat"); expect(runtime.getAccount().dailyPnl).toBe(0);
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith("paper");
    expect(mocks.load.mock.invocationCallOrder[0]).toBeLessThan(mocks.http.mock.invocationCallOrder[0]!);
  });
  it("waits for the history read before starting HTTP or ingestors", async () => {
    let resolve!: (value: { decisions: []; trades: [] }) => void;
    mocks.load.mockReturnValue(new Promise(r => { resolve = r; }));
    await import("./index.js"); await vi.waitFor(() => expect(mocks.load).toHaveBeenCalled());
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.marketStart).not.toHaveBeenCalled();
    resolve({ decisions: [], trades: [] }); await vi.waitFor(() => expect(started).toBe(true));
  });
  it("fails startup on a history-read error rather than displaying an empty recovery", async () => {
    mocks.load.mockRejectedValue(new Error("history unavailable"));
    await import("./index.js"); await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(mocks.http).not.toHaveBeenCalled(); expect(mocks.marketStart).not.toHaveBeenCalled();
  });
});
