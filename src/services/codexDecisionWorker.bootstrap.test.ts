import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import type { DecisionContext } from "../domain/types.js";
import { CodexDecisionWorker } from "./codexDecisionWorker.js";

const sdk = vi.hoisted(() => ({ construct: vi.fn(), start: vi.fn(), run: vi.fn() }));
vi.mock("@openai/codex-sdk", () => ({ Codex: class {
  constructor() { sdk.construct(); }
  startThread(options: unknown) { sdk.start(options); return { run: sdk.run }; }
}}));
const signal = { bias: "FLAT", confidence: 0.5, setup_type: "continuation",
  invalidation_price: null, holding_horizon_minutes: 60, reasoning_summary: "No momentum confirmation is available." };
const context = { market_snapshot: { symbol: "BTCUSDT" }, trigger: {}, context_summary: {} } as DecisionContext;
const makeWorker = (fallback = true) => new CodexDecisionWorker(
  { ...config, codex: { ...config.codex, useCliFallback: fallback } },
  { warn: vi.fn() } as unknown as Logger
);
const mockCli = (worker: CodexDecisionWorker) => vi.spyOn(
  worker as unknown as { runViaCli: (prompt: string) => Promise<unknown> }, "runViaCli"
).mockResolvedValue(signal);

beforeEach(() => {
  sdk.construct.mockReset(); sdk.start.mockReset(); sdk.run.mockReset();
  sdk.run.mockResolvedValue({ finalResponse: JSON.stringify(signal) });
});
afterEach(() => vi.restoreAllMocks());

describe("SDK bootstrap fallback", () => {
  it("does not initialize the SDK during worker construction", () => {
    makeWorker();
    expect(sdk.construct).not.toHaveBeenCalled();
    expect(sdk.start).not.toHaveBeenCalled();
  });
  it.each(["constructor", "startThread"])("falls back when the SDK %s fails", async (stage) => {
    const worker = makeWorker(); const cli = mockCli(worker);
    (stage === "constructor" ? sdk.construct : sdk.start).mockImplementationOnce(() => { throw new Error("bootstrap failed"); });
    await expect(worker.decide(context)).resolves.toMatchObject({ ...signal, invalidation_price: undefined });
    expect(cli).toHaveBeenCalledOnce(); expect(sdk.run).not.toHaveBeenCalled();
  });
  it("preserves the original bootstrap error when fallback is disabled", async () => {
    const worker = makeWorker(false); const cli = mockCli(worker); const error = new Error("bootstrap failed");
    sdk.start.mockImplementationOnce(() => { throw error; });
    await expect(worker.decide(context)).rejects.toBe(error); expect(cli).not.toHaveBeenCalled();
  });
  it("retries failed initialization on the next decision and then reuses the thread", async () => {
    const worker = makeWorker(); const cli = mockCli(worker);
    sdk.start.mockImplementationOnce(() => { throw new Error("transient bootstrap"); });
    await worker.decide(context); await worker.decide(context); await worker.decide(context);
    expect(sdk.start).toHaveBeenCalledTimes(2); expect(sdk.run).toHaveBeenCalledTimes(2);
    expect(cli).toHaveBeenCalledOnce();
  });
  it("keeps the SDK run failure fallback", async () => {
    const worker = makeWorker(); const cli = mockCli(worker);
    sdk.run.mockRejectedValueOnce(new Error("run failed"));
    await expect(worker.decide(context)).resolves.toMatchObject({ ...signal, invalidation_price: undefined }); expect(cli).toHaveBeenCalledOnce();
  });
});
