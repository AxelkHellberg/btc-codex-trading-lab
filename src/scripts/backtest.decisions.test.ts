import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExecutionPlan } from "../domain/types.js";
const seen = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), actions: [] as string[] }));
vi.mock("../logger.js", () => ({ logger: { info: seen.info, error: seen.error } }));
vi.mock("../infra/binance/binanceFuturesClient.js", () => ({
  BinanceFuturesClient: class {
    async getSymbolFilters() { return { tickSize: 0.0001, stepSize: 0.001, minQty: 0.001 }; }
  }
}));
vi.mock("../services/brokers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/brokers.js")>();
  return { ...actual, PaperBroker: class extends actual.PaperBroker {
    override execute(...args: Parameters<InstanceType<typeof actual.PaperBroker>["execute"]>) {
      seen.actions.push((args[0] as ExecutionPlan).action); return super.execute(...args);
    }
  } };
});
let directory: string;
const start = Date.UTC(2020, 0, 1);
const closeTime = (index: number) => start + (index + 1) * 60_000 - 1;
const row = (index: number, bias: string) => ({ timestamp: closeTime(index), signal: {
  bias, confidence: 0.9, setup_type: bias === "LONG" ? "breakout" : "protective_exit",
  invalidation_price: bias === "LONG" ? 100.45 : null, holding_horizon_minutes: 180,
  reasoning_summary: "Recorded synthetic decision for offline regression."
} });
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); seen.actions.length = 0;
  directory = await mkdtemp(join(tmpdir(), "recorded-decisions-"));
  const rows = Array.from({ length: 63 }, (_, i) => {
    const price = i < 60 ? "100" : String(101 + (i - 60) * 0.05);
    return [start + i * 60_000, price, price, price, price, i === 60 ? "100" : "1",
      closeTime(i), "0", 1, "0", "0", "0"];
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(rows))));
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("unexpected process exit"); });
});
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const run = async (records: unknown[]) => {
  const path = join(directory, "decisions.json"); await writeFile(path, JSON.stringify(records));
  vi.stubEnv("BACKTEST_DECISIONS_FILE", path);
  await import("./backtest.js");
  await vi.waitFor(() => expect(seen.info).toHaveBeenCalledWith(expect.anything(), "Backtest completed"));
  expect(seen.error).not.toHaveBeenCalled();
  return seen.info.mock.calls.at(-1)![0];
};
it("routes recorded entries, partial reductions and closes through the real planner, risk engine and broker", async () => {
  const result = await run([row(60, "LONG"), row(61, "REDUCE"), row(62, "CLOSE")]);
  expect(seen.actions).toEqual(["LONG", "REDUCE", "CLOSE"]);
  expect(result).toMatchObject({ entries: 1, exits: 1, decisionExits: 1, decisionReductions: 1,
    lifecycleExits: 0, recordedSignalsApplied: 3, unusedRecordedSignals: 0, decisionSource: "recorded" });
  expect(result.wins + result.losses).toBe(1);
});
it("does not apply future records early or invent heuristic entries for missing records", async () => {
  const result = await run([row(63, "LONG")]);
  expect(seen.actions).toEqual([]);
  expect(result).toMatchObject({ entries: 0, decisionExits: 0, recordedSignalsApplied: 0, unusedRecordedSignals: 1 });
});
it("keeps a recorded close while flat subject to the real planning and risk checks", async () => {
  const result = await run([row(60, "CLOSE")]);
  expect(seen.actions).toEqual([]); expect(result.exits).toBe(0);
});
