import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountState, DecisionContext, RiskEvaluation } from "../domain/types.js";

const seen = vi.hoisted(() => ({
  info: vi.fn(), error: vi.fn(), execute: vi.fn(),
  account: {} as AccountState,
  contexts: [] as DecisionContext[], evaluations: [] as RiskEvaluation[]
}));

vi.mock("../logger.js", () => ({ logger: { info: seen.info, error: seen.error } }));
vi.mock("../infra/binance/binanceFuturesClient.js", () => ({
  BinanceFuturesClient: class {
    async getSymbolFilters() { return { tickSize: 0.0001, stepSize: 0.001, minQty: 0.001 }; }
  }
}));
vi.mock("../services/brokers.js", () => ({
  PaperBroker: class {
    async onMarketSnapshot() { return null; }
    getState() {
      return {
        accountState: seen.account,
        positionState: { side: "flat", quantity: 0, entryPrice: 0, markPrice: 0, leverage: 1, unrealizedPnl: 0, realizedPnl: 0 }
      };
    }
    async execute() { seen.execute(); return { accepted: false }; }
  }
}));
vi.mock("../services/riskEngine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/riskEngine.js")>();
  return {
    RiskEngine: class extends actual.RiskEngine {
      override evaluate(...args: Parameters<InstanceType<typeof actual.RiskEngine>["evaluate"]>) {
        const result = super.evaluate(...args);
        seen.contexts.push(args[0]);
        seen.evaluations.push(result);
        return result;
      }
    }
  };
});

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  seen.contexts.length = 0; seen.evaluations.length = 0;
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([
  ["healthy", {}, true, undefined],
  ["daily loss", { dailyPnl: -1_000 }, false, "daily loss limit reached"],
  ["weekly drawdown", { weeklyDrawdown: 0.5 }, false, "weekly drawdown exceeded"],
  ["recent losses", { consecutiveLosses: 2, ageMinutes: 59 }, false, "cooldown active after losses"],
  ["cooldown boundary", { consecutiveLosses: 2, ageMinutes: 60 }, true, undefined],
  ["old losses", { consecutiveLosses: 2, ageMinutes: 61 }, true, undefined],
  ["single loss", { consecutiveLosses: 1, ageMinutes: 1 }, true, undefined]
])("uses historical account risk for %s", async (_name, overrides, approved, reason) => {
  const { config } = await import("../config.js");
  const start = Date.UTC(2020, 0, 1);
  const rows = Array.from({ length: 61 }, (_, i) => {
    const price = i < 60 ? "100" : "101";
    return [start + i * 60_000, price, price, price, price, i === 60 ? "100" : "1",
      start + (i + 1) * 60_000 - 1, "0", 1, "0", "0", "0"];
  });
  const replayTime = rows[60]![6] as number;
  const values = overrides as Partial<AccountState> & { ageMinutes?: number };
  seen.account = {
    equity: 10_000, walletBalance: 10_000, availableBalance: 10_000,
    dailyPnl: 0, weeklyDrawdown: 0, consecutiveLosses: 0, openOrders: 0,
    updatedAt: replayTime, ...values,
    lastLossAt: values.ageMinutes === undefined ? undefined
      : replayTime - (values.ageMinutes / 60) * config.riskPolicy.cooldownMinutes * 60_000
  };
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows)));
  vi.stubGlobal("fetch", fetchMock);
  const exit = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("unexpected process exit"); });
  await import("./backtest.js");
  await vi.waitFor(() => expect(seen.info).toHaveBeenCalledWith(expect.anything(), "Backtest completed"));
  expect(exit).not.toHaveBeenCalled();
  expect(seen.error).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(seen.evaluations).toHaveLength(1);
  expect(seen.evaluations[0]?.approved).toBe(approved);
  expect(seen.execute).toHaveBeenCalledTimes(approved ? 1 : 0);
  if (reason) expect(seen.evaluations[0]?.reasons).toContain(reason);
  const { RuntimeState } = await import("../services/runtimeState.js");
  const runtime = new RuntimeState(10_000);
  runtime.setAccount(seen.account);
  const clock = vi.spyOn(Date, "now").mockReturnValue(replayTime);
  expect(seen.contexts[0]?.risk_state).toEqual(runtime.getRiskState(config.riskPolicy));
  clock.mockRestore();
});
