import { afterEach, describe, expect, it, vi } from "vitest";
import type { DecisionContext } from "../domain/types.js";
import { RuntimeState } from "../services/runtimeState.js";

const harness = vi.hoisted(() => ({ contexts: [] as DecisionContext[], done: vi.fn() }));
vi.mock("../logger.js", () => ({ logger: { info: harness.done, error: vi.fn() } }));
vi.mock("../infra/binance/binanceFuturesClient.js", () => ({
  BinanceFuturesClient: class {
    getSymbolFilters = async () => ({ tickSize: 0.1, stepSize: 0.001, minQty: 0.001, minNotional: 5 });
  }
}));
vi.mock("../services/brokers.js", () => ({
  PaperBroker: class { onMarketSnapshot = async () => undefined; getState = () => ({
    accountState: { equity: 10_000, walletBalance: 10_000, availableBalance: 10_000,
      dailyPnl: 0, weeklyDrawdown: 0, consecutiveLosses: 0, openOrders: 0, updatedAt: 0 },
    positionState: { side: "flat", quantity: 0, entryPrice: 0, markPrice: 0, leverage: 1,
      unrealizedPnl: 0, realizedPnl: 0 }
  }); }
}));
vi.mock("../services/strategyPlanner.js", () => ({
  StrategyPlanner: class {
    plan(context: DecisionContext) { harness.contexts.push(context); return {}; }
  }
}));
vi.mock("../services/riskEngine.js", () => ({
  RiskEngine: class { evaluate = () => ({ approved: false }); }
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  harness.contexts.length = 0;
  harness.done.mockClear();
});

describe("historical decision context parity", () => {
  it.each([
    ["rising prices", 0.001, 1],
    ["falling prices", -0.001, 1],
    ["flat prices with accelerating volume", 0, 8],
    ["strong trend", 0.03, 2]
  ] as const)("uses runtime summary semantics for %s", async (_name, slope, finalVolume) => {
    const candles = Array.from({ length: 63 }, (_, index) => {
      const close = 100 + slope * index;
      return [index * 60_000, String(close), String(close + 1), String(close - 1),
        String(close), String(index >= 58 ? finalVolume : 1), (index + 1) * 60_000 - 1,
        "0", 1, "0", "0", "0"];
    });
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => candles });
    vi.stubGlobal("fetch", fetchMock);
    await import("./backtest.js");
    await vi.waitFor(() => expect(harness.done).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(harness.contexts).toHaveLength(3);
    for (const replay of harness.contexts) {
      const runtime = new RuntimeState(10_000);
      runtime.setMarket(replay.market_snapshot);
      const live = runtime.buildDecisionContext(replay.trigger, {
        maxDailyLoss: 0.03, maxWeeklyDrawdown: 0.1, cooldownMinutes: 30
      });
      expect(replay.context_summary).toEqual(live?.context_summary);
    }
  });
});
