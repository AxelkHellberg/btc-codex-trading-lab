import { describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { ExecutionResult } from "../domain/types.js";
import { ExecutionEngine } from "./executionEngine.js";
import { RuntimeState } from "./runtimeState.js";

const policy = { maxDailyLoss: 0.02, maxWeeklyDrawdown: 0.05, cooldownMinutes: 60 };
const seed = () => {
  const runtime = new RuntimeState(10_000);
  runtime.setAccount({ ...runtime.getAccount(), dailyPnl: -300, weeklyDrawdown: 0.08,
    consecutiveLosses: 2, lastLossAt: Date.now() });
  return runtime;
};
const exchange = (runtime: RuntimeState) => ({ ...runtime.getAccount(), walletBalance: 9_700,
  equity: 9_600, availableBalance: 9_000, openOrders: 3, updatedAt: Date.now() + 1,
  dailyPnl: 0, weeklyDrawdown: 0, consecutiveLosses: 0, lastLossAt: undefined });

it("preserves all breached risk guards while refreshing exchange-owned fields", () => {
  const runtime = seed();
  const previous = runtime.getAccount();
  const account = exchange(runtime);
  runtime.syncExchangeAccount(account);
  expect(runtime.getAccount()).toEqual({ ...account, dailyPnl: previous.dailyPnl,
    weeklyDrawdown: previous.weeklyDrawdown, consecutiveLosses: previous.consecutiveLosses,
    lastLossAt: previous.lastLossAt });
  expect(runtime.getRiskState(policy)).toMatchObject({ withinDailyLossLimit: false,
    withinWeeklyDrawdown: false, cooldownActive: true });
  runtime.syncExchangeAccount({ ...account, equity: 9_650 });
  expect(runtime.getRiskState(policy).reasons).toHaveLength(3);
});

describe("execution result account ownership", () => {
  it.each(["live", "paper"] as const)("uses the %s account contract", async (mode) => {
    const runtime = seed();
    const result: ExecutionResult = { accepted: false, tradeId: "test", broker: "stub", message: "rejected",
      accountState: exchange(runtime), positionState: runtime.getPosition() };
    const engine = new ExecutionEngine({ ...config, tradingMode: mode }, runtime,
      {} as never, { notify: vi.fn() } as never, {} as never, {} as never);
    await engine.handleExecutionResult(result);
    expect(runtime.getAccount().dailyPnl).toBe(mode === "live" ? -300 : 0);
    expect(runtime.getAccount().equity).toBe(9_600);
  });

  it("keeps setAccount authoritative for restored or paper risk history", () => {
    const runtime = seed();
    runtime.setAccount(exchange(runtime));
    expect(runtime.getAccount().dailyPnl).toBe(0);
    expect(runtime.getRiskState(policy).cooldownActive).toBe(false);
  });
});
