import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const mocks = vi.hoisted(() => ({
  paper: undefined as any, runtime: undefined as any,
  handleResult: vi.fn(),
  init: vi.fn(), pgClose: vi.fn(), redisClose: vi.fn(), acquire: vi.fn(), release: vi.fn(), setJson: vi.fn(),
  saveSnapshot: vi.fn(), heartbeat: vi.fn(), decide: vi.fn(), execute: vi.fn(), notify: vi.fn(),
  marketStop: vi.fn(), httpStop: vi.fn(), handleMarket: vi.fn(), detectorHeartbeat: vi.fn(),
  info: vi.fn(), error: vi.fn(), warn: vi.fn(), callbacks: {} as any,
  trigger: undefined as undefined | (() => Promise<void>), signals: new Map<string, () => void>()
}));
vi.mock("./logger.js", () => ({ logger: { info: mocks.info, error: mocks.error, warn: mocks.warn } }));
vi.mock("./infra/store/postgresStateStore.js", () => ({ PostgresStateStore: class {
  init = mocks.init; close = mocks.pgClose; saveSnapshot = mocks.saveSnapshot; heartbeat = mocks.heartbeat;
} }));
vi.mock("./infra/store/redisHotStore.js", () => ({ RedisHotStore: class {
  close = mocks.redisClose; acquireLock = mocks.acquire; releaseLock = mocks.release; setJson = mocks.setJson;
} }));
vi.mock("./http/server.js", () => ({ createHttpServer: async (_runtime: unknown, _port: unknown, trigger: () => Promise<void>) => {
  mocks.trigger = trigger; return { start: async () => {}, stop: mocks.httpStop };
} }));
vi.mock("./services/marketIngestor.js", () => ({ MarketIngestor: class {
  constructor(_config: unknown, _client: unknown, _logger: unknown, callbacks: unknown) { mocks.callbacks = callbacks; }
  start = async () => {}; stop = mocks.marketStop;
} }));
vi.mock("./services/newsIngestor.js", () => ({ NewsIngestor: class { start = async () => {}; stop = () => {}; } }));
vi.mock("./services/onchainIngestor.js", () => ({ OnchainIngestor: class { start = async () => {}; stop = () => {}; } }));
vi.mock("./infra/binance/binanceFuturesClient.js", () => ({ BinanceFuturesClient: class {} }));
vi.mock("./infra/notifier/telegramNotifier.js", () => ({ TelegramNotifier: class { notify = mocks.notify; } }));
vi.mock("./services/codexDecisionWorker.js", () => ({ CodexDecisionWorker: class { decide = mocks.decide; } }));
vi.mock("./services/brokers.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./services/brokers.js")>();
  return { ...actual, PaperBroker: class extends actual.PaperBroker {
    constructor(config: any) { super({ ...config, takerFeeBps: 0, slippageBps: 0 }); mocks.paper = this; }
  } };
});
vi.mock("./services/executionEngine.js", () => ({ ExecutionEngine: class { maybeExecute = mocks.execute; handleExecutionResult = mocks.handleResult; } }));
vi.mock("./services/strategyPlanner.js", () => ({ StrategyPlanner: class { plan = () => ({}); } }));
vi.mock("./services/riskEngine.js", () => ({ RiskEngine: class { evaluate = () => ({}); } }));
vi.mock("./services/runtimeState.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./services/runtimeState.js")>();
  return { RuntimeState: class extends actual.RuntimeState { constructor(balance: number) { super(balance); mocks.runtime = this; } } };
});
vi.mock("./services/eventDetector.js", () => ({ EventDetector: class {
  constructor(trigger: (value: any) => Promise<void>) {
    mocks.detectorHeartbeat.mockImplementation(() => trigger({ reason: "minute_recheck", triggeredAt: Date.now() }));
  }
  handleMarket = mocks.handleMarket; heartbeat = mocks.detectorHeartbeat;
} }));

const deferred = () => { let resolve!: (value?: any) => void; let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let exit: MockInstance<typeof process.exit>;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); mocks.signals.clear(); mocks.trigger = undefined;
  for (const value of Object.values(mocks)) if (vi.isMockFunction(value)) value.mockReset();
  for (const fn of [mocks.init, mocks.pgClose, mocks.redisClose, mocks.release, mocks.setJson, mocks.saveSnapshot,
    mocks.handleResult, mocks.heartbeat, mocks.decide, mocks.execute, mocks.notify, mocks.marketStop, mocks.httpStop, mocks.handleMarket]) fn.mockResolvedValue(undefined);
  mocks.acquire.mockResolvedValue(true);
  const original = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...args: any[]) => void) => {
    if (event === "SIGINT" || event === "SIGTERM") { mocks.signals.set(event, listener); return process; }
    return original(event as never, listener);
  }) as typeof process.on);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const start = async () => { await import("./index.js"); await vi.waitFor(() => expect(mocks.info).toHaveBeenCalled()); };
const stop = () => mocks.signals.get("SIGTERM")!();
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const expectOpenStores = () => { expect(mocks.pgClose).not.toHaveBeenCalled(); expect(mocks.redisClose).not.toHaveBeenCalled(); };
const expectClosed = async () => { await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  expect(mocks.redisClose).toHaveBeenCalledOnce(); expect(mocks.pgClose).toHaveBeenCalledOnce(); };


const market = { symbol: "BTCUSDT", markPrice: 100_000, bestAsk: 100_000, bestBid: 100_000,
  filters: { tickSize: 0.1, stepSize: 0.001, minQty: 0.001 }, timestamp: 10_000 };
const plan = { action: "LONG", side: "BUY", entryType: "MARKET", leverage: 2, quantity: 0.02,
  notionalUsd: 2000, entryPrice: 100_000, stopLoss: 99_000, tp1: 101_500, tp2: 103_000,
  breakEvenTriggerR: 1, trailingTriggerR: 2, trailingOffset: 1000, initialRiskPerUnit: 1000,
  maxHoldUntil: Number.MAX_SAFE_INTEGER, confidence: 0.8, setupType: "breakout", regimeAtEntry: "trend_up",
  entryReason: "test", reasoningSummary: "test", invalidationPrice: 99_000 };
describe("paper snapshots in the actual entrypoint", () => {
  it("persists a non-exit tick's equity and break-even protection to both stores", async () => {
    await start(); await mocks.paper.execute(plan, { market_snapshot: market });
    await mocks.callbacks.onMarket({ ...market, markPrice: 101_050 });
    expect(mocks.handleResult).not.toHaveBeenCalled();
    const state = mocks.paper.getState();
    expect(state.positionState).toMatchObject({ side: "long", stopLoss: 100_000, breakEvenArmed: true });
    expect(state.accountState.equity).toBeGreaterThan(state.accountState.walletBalance);
    expect(mocks.saveSnapshot).toHaveBeenCalledWith("account", state.accountState);
    expect(mocks.saveSnapshot).toHaveBeenCalledWith("position", state.positionState);
    expect(mocks.setJson).toHaveBeenCalledWith("latest:account", state.accountState, 300);
    expect(mocks.setJson).toHaveBeenCalledWith("latest:position", state.positionState, 300);
    expect(mocks.runtime.getPosition()).toEqual(state.positionState);
    stop(); await expectClosed();
  });
  it("persists one final account/position pair for an exit instead of writing it twice", async () => {
    await start(); await mocks.paper.execute(plan, { market_snapshot: market });
    await mocks.callbacks.onMarket({ ...market, markPrice: 98_900 });
    expect(mocks.handleResult).toHaveBeenCalledOnce();
    expect(mocks.saveSnapshot.mock.calls.filter(([kind]) => kind === "account")).toHaveLength(1);
    expect(mocks.saveSnapshot.mock.calls.filter(([kind]) => kind === "position")).toHaveLength(1);
    expect(mocks.saveSnapshot).toHaveBeenCalledWith("position", expect.objectContaining({ side: "flat", quantity: 0 }));
    stop(); await expectClosed();
  });
  it("surfaces a state snapshot write failure and permits a later tick to refresh it", async () => {
    await start(); await mocks.paper.execute(plan, { market_snapshot: market });
    mocks.saveSnapshot.mockImplementation(async kind => { if (kind === "account") throw new Error("snapshot unavailable"); });
    await expect(mocks.callbacks.onMarket({ ...market, markPrice: 100_500 })).rejects.toThrow("snapshot unavailable");
    mocks.saveSnapshot.mockResolvedValue(undefined);
    await mocks.callbacks.onMarket({ ...market, markPrice: 100_600 });
    expect(mocks.setJson).toHaveBeenCalledWith("latest:account", mocks.paper.getState().accountState, 300);
    expect(mocks.handleResult).not.toHaveBeenCalled(); stop(); await expectClosed();
  });
  it.each(["Postgres", "Redis"])("closes once on a stop-crossing tick despite a %s market write failure", async sink => {
    await start(); await mocks.paper.execute(plan, { market_snapshot: market });
    const failure = new Error("market unavailable");
    if (sink === "Postgres") mocks.saveSnapshot.mockImplementation(async kind => { if (kind === "market") throw failure; });
    else mocks.setJson.mockImplementation(async key => { if (key === "latest:market") throw failure; });
    await expect(mocks.callbacks.onMarket({ ...market, markPrice: 98_900 })).rejects.toThrow("market unavailable");
    expect(mocks.paper.getState().positionState.side).toBe("flat");
    expect(mocks.runtime.getPosition().side).toBe("flat");
    expect(mocks.handleResult).toHaveBeenCalledOnce();
    expect(mocks.saveSnapshot).toHaveBeenCalledWith("position", expect.objectContaining({ side: "flat" }));
    expect(mocks.handleMarket).not.toHaveBeenCalled();
    mocks.saveSnapshot.mockResolvedValue(undefined); mocks.setJson.mockResolvedValue(undefined);
    await mocks.callbacks.onMarket({ ...market, markPrice: 100_500 });
    expect(mocks.handleResult).toHaveBeenCalledOnce();
    expect(mocks.handleMarket).toHaveBeenCalledOnce();
    stop(); await expectClosed();
  });
  it("keeps the paper stop effective while a market write is still pending", async () => {
    await start(); await mocks.paper.execute(plan, { market_snapshot: market });
    const pendingWrite = deferred();
    mocks.saveSnapshot.mockImplementation(kind => kind === "market" ? pendingWrite.promise : Promise.resolve());
    const tick = mocks.callbacks.onMarket({ ...market, markPrice: 98_900 });
    await flush();
    expect(mocks.paper.getState().positionState.side).toBe("flat");
    expect(mocks.runtime.getPosition().side).toBe("flat");
    expect(mocks.handleMarket).not.toHaveBeenCalled();
    pendingWrite.resolve(); await tick;
    expect(mocks.handleResult).toHaveBeenCalledOnce(); stop(); await expectClosed();
  });
  it("does not let a delayed detector apply an older tick after a newer tick arms break-even", async () => {
    await start(); await mocks.paper.execute(plan, { market_snapshot: market });
    const decision = deferred(); mocks.handleMarket.mockReturnValueOnce(decision.promise);
    const earlier = mocks.callbacks.onMarket({ ...market, markPrice: 99_500 }); await flush();
    await mocks.callbacks.onMarket({ ...market, markPrice: 101_050 });
    expect(mocks.paper.getState().positionState).toMatchObject({ side: "long", breakEvenArmed: true });
    decision.resolve(); await earlier;
    expect(mocks.paper.getState().positionState.side).toBe("long");
    expect(mocks.handleResult).not.toHaveBeenCalled(); stop(); await expectClosed();
  });
  it("keeps an exit audit failure observable and does not retry the fill", async () => {
    await start(); await mocks.paper.execute(plan, { market_snapshot: market });
    mocks.handleResult.mockRejectedValueOnce(new Error("exit audit unavailable"));
    await expect(mocks.callbacks.onMarket({ ...market, markPrice: 98_900 })).rejects.toThrow("exit audit unavailable");
    expect(mocks.runtime.getPosition().side).toBe("flat");
    expect(mocks.handleMarket).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith(expect.objectContaining({ tradeId: expect.any(String) }),
      "Paper execution result handling failed; inspect audit state");
    await mocks.callbacks.onMarket({ ...market, markPrice: 100_500 });
    expect(mocks.handleResult).toHaveBeenCalledOnce(); stop(); await expectClosed();
  });

});
