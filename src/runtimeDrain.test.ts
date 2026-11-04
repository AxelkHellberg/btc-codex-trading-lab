import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const mocks = vi.hoisted(() => ({
  persistenceStop: vi.fn(), init: vi.fn(), pgClose: vi.fn(), redisClose: vi.fn(), acquire: vi.fn(), release: vi.fn(), setJson: vi.fn(),
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
vi.mock("./services/brokers.js", () => ({ LiveBroker: class {}, PaperBroker: class {} }));
vi.mock("./services/tradePersistenceQueue.js", () => ({ TradePersistenceQueue: class { stop = mocks.persistenceStop; status = () => ({ pending: 0 }); } }));
vi.mock("./services/executionEngine.js", () => ({ ExecutionEngine: class { maybeExecute = mocks.execute; } }));
vi.mock("./services/strategyPlanner.js", () => ({ StrategyPlanner: class { plan = () => ({}); } }));
vi.mock("./services/riskEngine.js", () => ({ RiskEngine: class { evaluate = () => ({}); } }));
vi.mock("./services/runtimeState.js", () => ({ RuntimeState: class {
  buildDecisionContext = () => ({}); setMarket = () => {}; setAccount = () => {}; setPosition = () => {}; getMarket = () => ({});
} }));
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
  for (const fn of [mocks.persistenceStop, mocks.init, mocks.pgClose, mocks.redisClose, mocks.release, mocks.setJson, mocks.saveSnapshot,
    mocks.heartbeat, mocks.decide, mocks.execute, mocks.notify, mocks.marketStop, mocks.httpStop, mocks.handleMarket]) fn.mockResolvedValue(undefined);
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

describe("runtime shutdown draining", () => {
  it("waits for accepted execution before stopping audit retries, then closes stores", async () => {
    const execution = deferred();
    const retries = deferred();
    mocks.execute.mockReturnValue(execution.promise);
    mocks.persistenceStop.mockReturnValue(retries.promise);
    await start();
    const trigger = mocks.trigger!();
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    stop(); await flush();
    expect(mocks.persistenceStop).not.toHaveBeenCalled();
    expectOpenStores();
    execution.resolve(); await trigger; await flush();
    expect(mocks.persistenceStop).toHaveBeenCalledOnce();
    expectOpenStores();
    retries.resolve(); await expectClosed();
    expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(mocks.persistenceStop.mock.invocationCallOrder[0]!);
    expect(mocks.persistenceStop.mock.invocationCallOrder[0]).toBeLessThan(mocks.pgClose.mock.invocationCallOrder[0]!);
  });
  it("finishes an accepted decision and releases its lock before closing stores, refusing later triggers", async () => {
    const decision = deferred(); mocks.decide.mockReturnValue(decision.promise); await start();
    const trigger = mocks.trigger!(); await vi.waitFor(() => expect(mocks.decide).toHaveBeenCalled());
    stop(); stop(); await flush(); expect(mocks.marketStop).toHaveBeenCalledOnce(); expectOpenStores();
    await mocks.trigger!(); expect(mocks.acquire).toHaveBeenCalledOnce();
    decision.resolve({ bias: "FLAT" }); await trigger; await expectClosed();
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.release.mock.invocationCallOrder[0]).toBeLessThan(mocks.redisClose.mock.invocationCallOrder[0]!);
    expect(exit).toHaveBeenCalledOnce();
  });
  it.each([false, true])("also tracks a decision still awaiting lock acquisition (%s)", async acquired => {
    const lock = deferred(); mocks.acquire.mockReturnValue(lock.promise); await start();
    const trigger = mocks.trigger!(); await flush(); stop(); await flush(); expectOpenStores();
    lock.resolve(acquired); await trigger; await expectClosed();
    expect(mocks.release).toHaveBeenCalledTimes(acquired ? 1 : 0);
  });
  it("drains in-flight ingestion persistence and refuses new callbacks during teardown", async () => {
    const write = deferred(); mocks.saveSnapshot.mockReturnValue(write.promise); await start();
    const callback = mocks.callbacks.onMarket({ markPrice: 100 }); await flush();
    stop(); await flush(); expectOpenStores();
    await mocks.callbacks.onAccount({ equity: 100 }); expect(mocks.saveSnapshot).toHaveBeenCalledOnce();
    write.resolve(); await callback; await expectClosed();
    expect(mocks.setJson.mock.invocationCallOrder[0]).toBeLessThan(mocks.redisClose.mock.invocationCallOrder[0]!);
  });
  it("drains an active heartbeat without admitting its follow-on decision after shutdown", async () => {
    const beat = deferred(); mocks.heartbeat.mockReturnValue(beat.promise); await start();
    await vi.advanceTimersByTimeAsync(60_000); expect(mocks.heartbeat).toHaveBeenCalledOnce();
    stop(); await flush(); expectOpenStores(); beat.resolve(); await expectClosed();
    expect(mocks.acquire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); expect(mocks.heartbeat).toHaveBeenCalledOnce();
  });
  it("keeps stores open through failure reporting and the finally lock release", async () => {
    const failed = deferred(); const notification = deferred(); mocks.decide.mockReturnValue(failed.promise);
    mocks.notify.mockReturnValue(notification.promise); await start();
    const trigger = mocks.trigger!(); await flush(); stop(); failed.reject(new Error("evaluation failed"));
    await flush(); expect(mocks.notify).toHaveBeenCalledOnce(); expectOpenStores();
    notification.resolve(); await trigger; await expectClosed(); expect(mocks.release).toHaveBeenCalledOnce();
  });
  it("uses the existing nonzero shutdown deadline without closing stores underneath stuck work", async () => {
    const decision = deferred(); mocks.decide.mockReturnValue(decision.promise); await start();
    const trigger = mocks.trigger!(); await flush(); stop(); await vi.advanceTimersByTimeAsync(10_000);
    expect(exit).toHaveBeenCalledWith(1); expectOpenStores();
    decision.resolve({ bias: "FLAT" }); await trigger; await flush();
    expect(exit).toHaveBeenCalledOnce();
  });
});
