import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import type { ExecutionPlan } from "../domain/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const path of ["../config.js", "../logger.js", "../services/strategyPlanner.js", "../infra/binance/binanceFuturesClient.js"]) {
    vi.doUnmock(path);
  }
});

describe("backtest terminal accounting", () => {
  it.each([
    { name: "losing open position", finalPrice: 99_500, entryBar: 1, fees: 0, expectedEquity: 9_990, expectedPnl: -10, quantity: 0.02 },
    { name: "profitable open position", finalPrice: 100_500, entryBar: 1, fees: 0, expectedEquity: 10_010, expectedPnl: 10, quantity: 0.02 },
    { name: "final-bar entry with fees", finalPrice: 100_000, entryBar: 2, fees: 4, expectedEquity: 9_999.2, expectedPnl: 0, quantity: 0.02 },
    { name: "flat run", finalPrice: 100_000, entryBar: 0, fees: 0, expectedEquity: 10_000, expectedPnl: 0, quantity: 0 }
  ])("reports $name without inventing a closing fill", async ({ finalPrice, entryBar, fees, expectedEquity, expectedPnl, quantity }) => {
    vi.resetModules();
    const initialBalance = 10_000;
    vi.stubEnv("BACKTEST_INITIAL_BALANCE", String(initialBalance));
    const now = Date.now();
    const candles = Array.from({ length: 62 }, (_, index) => {
      const price = index === 61 ? finalPrice : 100_000;
      const openTime = now - (62 - index) * 60_000;
      return [openTime, String(price), String(price), String(price), String(price), "1", openTime + 59_999, "0", 1, "0", "0", "0"];
    });
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => candles });
    vi.stubGlobal("fetch", fetchMock);
    vi.doMock("../config.js", () => ({ config: { ...config, slippageBps: 0, takerFeeBps: fees } }));
    vi.doMock("../infra/binance/binanceFuturesClient.js", () => ({
      BinanceFuturesClient: class {
        getSymbolFilters = async () => ({ tickSize: 0.1, stepSize: 0.001, minQty: 0.001 });
      }
    }));
    let evaluations = 0;
    vi.doMock("../services/strategyPlanner.js", () => ({
      StrategyPlanner: class {
        plan = (context: { market_snapshot: { markPrice: number } }) => {
          evaluations += 1;
          const signal = { bias: "LONG", confidence: 0.7, setup_type: "breakout", holding_horizon_minutes: 90, reasoning_summary: "Offline replay fixture" };
          const plan: ExecutionPlan = {
            action: "LONG", side: "BUY", entryType: "MARKET", leverage: 2, quantity: 0.02,
            notionalUsd: 2_000, entryPrice: context.market_snapshot.markPrice,
            stopLoss: 99_000, tp2: 103_000, initialRiskPerUnit: 1_000,
            confidence: 0.7, setupType: "breakout", regimeAtEntry: "trend_up",
            entryReason: "Offline replay fixture", reasoningSummary: "Offline replay fixture"
          };
          return { normalizedSignal: signal, reasons: [], plan: evaluations === entryBar ? plan : undefined };
        };
      }
    }));
    let resolveResult!: (result: Record<string, any>) => void;
    let rejectResult!: (error: unknown) => void;
    const completed = new Promise<Record<string, any>>((resolve, reject) => {
      resolveResult = resolve; rejectResult = reject;
    });
    vi.doMock("../logger.js", () => ({ logger: {
      info: (result: Record<string, any>) => resolveResult(result),
      error: (result: { error: unknown }) => rejectResult(result.error)
    } }));
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("Unexpected replay exit"); });
    await import("./backtest.js");
    const result = await completed;
    expect(result.initialBalance).toBe(initialBalance);
    expect(result.finalEquity).toBeCloseTo(expectedEquity, 8);
    expect(result.finalWalletBalance).toBeCloseTo(initialBalance - (fees ? 0.8 : 0), 8);
    expect(result.unrealizedPnl).toBe(expectedPnl);
    expect(result.totalEquityReturn).toBeCloseTo((expectedEquity - initialBalance) / initialBalance, 10);
    expect(result.terminalPositionPolicy).toBe("leave_open_mark_to_market");
    expect(result.remainingPosition).toMatchObject({ side: quantity ? "long" : "flat", quantity });
    expect(result.exits).toBe(0);
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
