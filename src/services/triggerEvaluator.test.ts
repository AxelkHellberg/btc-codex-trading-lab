import pino from "pino";
import { config } from "../config.js";
import { describe, expect, it, vi } from "vitest";
import type { DecisionContext, EvaluationTrigger, RiskEvaluation, StrategySignal } from "../domain/types.js";
import { createTriggerEvaluator } from "./triggerEvaluator.js";
const trigger: EvaluationTrigger = { reason: "manual_recheck", priority: 3, details: "manual", triggeredAt: 123 };
function setup() {
  const context = {} as DecisionContext;
  const signal = {} as StrategySignal;
  const evaluation = { approved: false, reasons: ["risk rejected"] } as RiskEvaluation;
  const deps = {
    runtime: { buildDecisionContext: vi.fn((): DecisionContext | null => context) },
    hotStore: { acquireLock: vi.fn(async () => true), releaseLock: vi.fn(async () => {}), setJson: vi.fn(async () => {}) },
    decisionWorker: { decide: vi.fn(async () => signal) },
    planner: { plan: vi.fn(() => ({} as ReturnType<import("./strategyPlanner.js").StrategyPlanner["plan"]>)) },
    riskEngine: { evaluate: vi.fn(() => evaluation) },
    executionEngine: { maybeExecute: vi.fn(async () => {}) },
    notifier: { notify: vi.fn(async () => {}) }, logger: pino({ enabled: false }),
    riskPolicy: config.riskPolicy
  };
  return { deps, evaluate: createTriggerEvaluator(deps) };
}
describe("manual evaluation outcomes", () => {
  it("reports busy without model work or releasing another owner's lock", async () => {
    const { deps, evaluate } = setup();
    deps.hotStore.acquireLock.mockResolvedValue(false);
    expect(await evaluate(trigger)).toEqual({ status: "busy" });
    expect(deps.decisionWorker.decide).not.toHaveBeenCalled();
    expect(deps.hotStore.releaseLock).not.toHaveBeenCalled();
  });
  it("reports missing market and releases its acquired lock", async () => {
    const { deps, evaluate } = setup();
    deps.runtime.buildDecisionContext.mockReturnValue(null);
    expect(await evaluate(trigger)).toEqual({ status: "no_market" });
    expect(deps.hotStore.releaseLock).toHaveBeenCalledOnce();
    expect(deps.decisionWorker.decide).not.toHaveBeenCalled();
  });
  it("reports a completed evaluation even when risk correctly rejects an order", async () => {
    const { deps, evaluate } = setup();
    expect(await evaluate(trigger)).toEqual({ status: "completed" });
    expect(deps.executionEngine.maybeExecute).toHaveBeenCalledOnce();
    expect(deps.hotStore.releaseLock).toHaveBeenCalledOnce();
  });
  it.each(["model", "execution", "acquisition", "release"])("reports %s failures honestly", async (stage) => {
    const { deps, evaluate } = setup();
    if (stage === "model") deps.decisionWorker.decide.mockRejectedValue(new Error("private model detail"));
    if (stage === "execution") deps.executionEngine.maybeExecute.mockRejectedValue(new Error("store down"));
    if (stage === "acquisition") deps.hotStore.acquireLock.mockRejectedValue(new Error("redis down"));
    if (stage === "release") deps.hotStore.releaseLock.mockRejectedValue(new Error("release down"));
    expect(await evaluate(trigger)).toEqual({ status: "failed" });
    expect(deps.hotStore.releaseLock).toHaveBeenCalledTimes(stage === "acquisition" ? 0 : 1);
  });
  it("reports lock-release failure even when no market exists", async () => {
    const { deps, evaluate } = setup();
    deps.runtime.buildDecisionContext.mockReturnValue(null);
    deps.hotStore.releaseLock.mockRejectedValue(new Error("release down"));
    expect(await evaluate(trigger)).toEqual({ status: "failed" });
  });
  it("preserves failure outcome if notifying also fails", async () => {
    const { deps, evaluate } = setup();
    deps.decisionWorker.decide.mockRejectedValue(new Error("model down"));
    deps.notifier.notify.mockRejectedValue(new Error("telegram down"));
    expect(await evaluate(trigger)).toEqual({ status: "failed" });
  });
});

describe("EventDetector with real evaluator outcomes", () => {
  it.each(["busy", "no_market", "failed"] as const)("retries a real %s evaluation without consuming the cooldown", async (status) => {
    const { EventDetector } = await import("./eventDetector.js");
    const { deps, evaluate } = setup();
    if (status === "busy") deps.hotStore.acquireLock.mockResolvedValueOnce(false);
    if (status === "no_market") deps.runtime.buildDecisionContext.mockReturnValueOnce(null);
    if (status === "failed") deps.decisionWorker.decide.mockRejectedValueOnce(new Error("model down"));
    const detector = new EventDetector(evaluate);
    await detector.heartbeat();
    await detector.heartbeat();
    await detector.heartbeat();
    expect(deps.hotStore.acquireLock).toHaveBeenCalledTimes(2);
    expect(deps.executionEngine.maybeExecute).toHaveBeenCalledOnce();
  });
});
