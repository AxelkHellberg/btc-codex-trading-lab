import { describe, expect, it } from "vitest";
import { RuntimeState } from "./runtimeState.js";

const policy = { maxDailyLoss: 0.02, maxWeeklyDrawdown: 0.05, cooldownMinutes: 60 };
const day = Date.UTC(2026, 10, 7);
const update = (runtime: RuntimeState, walletBalance: number, dailyPnl: number, updatedAt = day) =>
  runtime.setAccount({ ...runtime.getAccount(), walletBalance, equity: walletBalance, dailyPnl, updatedAt });

describe("runtime daily loss reference for exchange and legacy snapshots", () => {
  it("keeps the original 200 loss limit through successive losses", () => {
    const runtime = new RuntimeState(10_000);
    update(runtime, 9_900, -100);
    update(runtime, 9_802, -198, day + 60_000);
    expect(runtime.getRiskState(policy).withinDailyLossLimit).toBe(true);
    update(runtime, 9_800, -200, day + 120_000);
    expect(runtime.getRiskState(policy).withinDailyLossLimit).toBe(false);
  });

  it("does not expand the loss budget after intraday gains or balance changes", () => {
    const runtime = new RuntimeState(10_000);
    update(runtime, 10_500, 500);
    update(runtime, 12_000, -200, day + 60_000);
    expect(runtime.getRiskState(policy).withinDailyLossLimit).toBe(false);
  });

  it("recovers the opening reference when the first snapshot arrives after a loss", () => {
    const runtime = new RuntimeState(1_000);
    update(runtime, 9_802, -198);
    expect(runtime.getRiskState(policy).withinDailyLossLimit).toBe(true);
  });

  it("reanchors only on a newer UTC day", () => {
    const runtime = new RuntimeState(10_000);
    update(runtime, 10_000, 0);
    update(runtime, 19_600, -400, day + 86_400_000);
    expect(runtime.getRiskState(policy).withinDailyLossLimit).toBe(false);
    update(runtime, 9_900, -100, day);
    update(runtime, 19_601, -399, day + 86_400_001);
    expect(runtime.getRiskState(policy).withinDailyLossLimit).toBe(true);
  });

  it("prefers the explicit persisted broker reference, including zero", () => {
    const runtime = new RuntimeState(10_000);
    runtime.setAccount({ ...runtime.getAccount(), walletBalance: 20_000, dailyPnl: -200,
      dailyLossReferenceBalance: 10_000, updatedAt: day });
    expect(runtime.getRiskState(policy).withinDailyLossLimit).toBe(false);
    runtime.setAccount({ ...runtime.getAccount(), dailyPnl: 0, dailyLossReferenceBalance: 0 });
    expect(runtime.getRiskState(policy).withinDailyLossLimit).toBe(false);
  });
});
