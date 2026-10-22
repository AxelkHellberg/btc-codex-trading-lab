import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

import type { PersistedTradeRecord } from "../domain/types.js";
import { RuntimeState } from "../services/runtimeState.js";
import { createHttpServer } from "./server.js";

const captured = vi.hoisted(() => ({ app: undefined as FastifyInstance | undefined }));
vi.mock("fastify", async (importOriginal) => {
  const original = await importOriginal<typeof import("fastify")>();
  return {
    ...original,
    default: (...args: Parameters<typeof original.default>) => {
      captured.app = original.default(...args);
      return captured.app;
    }
  };
});

afterEach(async () => {
  await captured.app?.close();
  captured.app = undefined;
});

function runtimeWithTrades(pnls: number[]): RuntimeState {
  const runtime = new RuntimeState(1000);
  pnls.forEach((netPnl, index) => {
    const trade: PersistedTradeRecord = {
      tradeId: String(index), mode: "paper", action: "LONG", side: "BUY",
      quantity: 1, remainingQuantity: 0, leverage: 1, entryPrice: 100,
      confidence: 1, status: "closed", entryReason: "fixture", exitReason: "fixture",
      entryFee: 0, exitFee: 0, grossPnl: netPnl, netPnl, mfe: 0, mae: 0,
      openedAt: 1, closedAt: 2, details: {}, createdAt: 1, updatedAt: 2
    };
    runtime.upsertTrade(trade);
  });
  return runtime;
}

const cases = [
  { label: "empty history", pnls: [], factor: null, status: "no_trades", text: "N/A", tone: "neutral" },
  { label: "breakeven history", pnls: [0, 0], factor: null, status: "no_profit_or_loss", text: "N/A", tone: "neutral" },
  { label: "small winner", pnls: [0.5], factor: null, status: "no_losses", text: "No losses", tone: "neutral" },
  { label: "scaled winner", pnls: [50], factor: null, status: "no_losses", text: "No losses", tone: "neutral" },
  { label: "winner and breakeven", pnls: [0, 0.5], factor: null, status: "no_losses", text: "No losses", tone: "neutral" },
  { label: "losses only", pnls: [-10, -20], factor: 0, status: "finite", text: "0", tone: "neutral" },
  { label: "mixed history", pnls: [50, -25], factor: 2, status: "finite", text: "2", tone: "positive" },
  { label: "mixed history below one", pnls: [1, -2], factor: 0.5, status: "finite", text: "0.5", tone: "neutral" },
  { label: "scaled mixed history", pnls: [500, -250], factor: 2, status: "finite", text: "2", tone: "positive" }
];

describe("profit factor contract", () => {
  it.each(cases)("serializes $label without substituting dollar profit", async ({ pnls, factor, status }) => {
    const runtime = runtimeWithTrades(pnls);
    expect(runtime.getTradeStats()).toMatchObject({ profitFactor: factor, profitFactorStatus: status });
    await createHttpServer(runtime, 0);
    const response = await captured.app!.inject({ method: "GET", url: "/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json().tradeStats).toMatchObject({ profitFactor: factor, profitFactorStatus: status });
    expect(response.body).not.toMatch(/NaN|Infinity/);
  });

  it.each(cases)("renders $label deliberately in the dashboard", async ({ pnls, text, tone }) => {
    await createHttpServer(runtimeWithTrades(pnls), 0);
    const statusResponse = await captured.app!.inject({ method: "GET", url: "/status" });
    const page = await captured.app!.inject({ method: "GET", url: "/" });
    const script = page.body.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    const nodes = new Map<string, { textContent?: string; className?: string; addEventListener: ReturnType<typeof vi.fn> }>();
    const context = {
      document: {
        getElementById: (id: string) => {
          if (!nodes.has(id)) nodes.set(id, { addEventListener: vi.fn() });
          return nodes.get(id)!;
        }
      },
      fetch: vi.fn(async () => ({ json: async () => statusResponse.json() })),
      setInterval: vi.fn(),
      console,
      firstRefresh: undefined as Promise<void> | undefined
    };
    runInNewContext(script!.replace("refresh().catch((error)", "globalThis.firstRefresh = refresh().catch((error)"), context);
    await context.firstRefresh;
    expect(nodes.get("heartbeat")?.textContent).toMatch(/^Live/);
    expect(nodes.get("profitFactor")).toMatchObject({ textContent: text, className: `mono ${tone}` });
  });
});
