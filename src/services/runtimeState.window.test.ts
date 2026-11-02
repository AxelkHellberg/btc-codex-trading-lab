import { describe, expect, it, vi } from "vitest";
import type { PersistedDecisionRecord, PersistedTradeRecord } from "../domain/types.js";
import { RuntimeState } from "./runtimeState.js";
import { createHttpServer } from "../http/server.js";

const routes = vi.hoisted(() => new Map<string, (...args: any[]) => any>());
vi.mock("fastify", () => ({ default: () => ({
  get: (path: string, handler: (...args: any[]) => any) => routes.set(path, handler),
  post: vi.fn(), listen: vi.fn(), close: vi.fn()
}) }));

const trade = (i: number, status = "closed"): PersistedTradeRecord => ({
  tradeId: String(i), mode: "paper", action: "LONG", side: "BUY", quantity: 1,
  remainingQuantity: status === "closed" ? 0 : 1, leverage: 1, entryPrice: 100,
  confidence: 1, status, entryReason: "fixture", entryFee: 0, exitFee: 0,
  grossPnl: i, netPnl: i, mfe: 0, mae: 0, openedAt: i, closedAt: i,
  details: {}, createdAt: i, updatedAt: i
});

// Context and signal are opaque to retention; use the declared record shape here.
const decision = (i: number) => ({ decisionId: String(i), createdAt: i } as PersistedDecisionRecord);

describe("recent metric window contract", () => {
  it("reports an empty process-local window before observations arrive", () => {
    expect(new RuntimeState(10_000).getMetricWindow()).toEqual({
      scope: "recent_in_memory", capacity: 25, decisionCount: 0, tradeCount: 0, closedTradeCount: 0
    });
  });

  it("reports rollover and excludes open trades from the closed sample", () => {
    const runtime = new RuntimeState(10_000);
    for (let i = 0; i < 26; i++) {
      runtime.pushDecision(decision(i));
      runtime.upsertTrade(trade(i, i === 25 ? "open" : "closed"));
    }
    expect(runtime.getRecentDecisions().map(x => x.decisionId)).not.toContain("0");
    expect(runtime.getRecentTrades().map(x => x.tradeId)).not.toContain("0");
    expect(runtime.getMetricWindow()).toEqual({
      scope: "recent_in_memory", capacity: 25, decisionCount: 25, tradeCount: 25, closedTradeCount: 24
    });
    expect(runtime.getTradeStats().realizedPnl).toBe(300);
    runtime.upsertTrade(trade(25));
    expect(runtime.getMetricWindow().tradeCount).toBe(25);
    expect(runtime.getMetricWindow().closedTradeCount).toBe(25);
    expect(runtime.getTradeStats().realizedPnl).toBe(325);
  });

  it("publishes the exact sample window and labels dashboard performance", async () => {
    const runtime = new RuntimeState(10_000);
    runtime.upsertTrade(trade(1));
    runtime.pushDecision(decision(1));
    await createHttpServer(runtime, 0);
    const status = await routes.get("/status")!();
    expect(status.metricWindow).toEqual(runtime.getMetricWindow());
    expect(status.recentTrades).toHaveLength(status.metricWindow.tradeCount);
    expect(status.recentDecisions).toHaveLength(status.metricWindow.decisionCount);
    const reply = { type: vi.fn().mockReturnThis(), send: vi.fn() };
    await routes.get("/")!({}, reply);
    const html = reply.send.mock.calls[0]![0];
    expect(html).toContain("Recent Realized PnL");
    expect(html).toContain("Recent Win Rate");
    expect(html).toContain("Recent Performance");
    expect(html).toContain("Resets on restart.");
    expect(html).toContain("metricWindow.closedTradeCount");
  });
});
