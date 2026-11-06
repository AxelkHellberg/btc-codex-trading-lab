import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  trigger: undefined as undefined | (() => Promise<void>),
  acquired: vi.fn(), renewed: vi.fn(), released: vi.fn(), decide: vi.fn(), execute: vi.fn(),
  warn: vi.fn(), error: vi.fn(),
}));
vi.mock("./config.js", () => ({ config: { tradingMode: "paper", paperStartingBalance: 10000, riskPolicy: {}, binance: {}, telegram: {} } }));
vi.mock("./logger.js", () => ({ logger: { info: vi.fn(), warn: mocks.warn, error: mocks.error } }));
vi.mock("./infra/store/postgresStateStore.js", () => ({ PostgresStateStore: class { init = vi.fn(); heartbeat = vi.fn(); } }));
vi.mock("./infra/store/redisHotStore.js", () => ({ RedisHotStore: class { acquireLock = mocks.acquired; renewLock = mocks.renewed; releaseLock = mocks.released; setJson = vi.fn(); } }));
vi.mock("./infra/notifier/telegramNotifier.js", () => ({ TelegramNotifier: class { notify = vi.fn(); } }));
vi.mock("./infra/binance/binanceFuturesClient.js", () => ({ BinanceFuturesClient: class {} }));
vi.mock("./services/brokers.js", () => ({ PaperBroker: class {}, LiveBroker: class {} }));
vi.mock("./services/executionEngine.js", () => ({ ExecutionEngine: class { maybeExecute = mocks.execute; } }));
vi.mock("./services/codexDecisionWorker.js", () => ({ CodexDecisionWorker: class { decide = mocks.decide; } }));
vi.mock("./services/strategyPlanner.js", () => ({ StrategyPlanner: class { plan = vi.fn(); } }));
vi.mock("./services/riskEngine.js", () => ({ RiskEngine: class { evaluate = vi.fn(); } }));
vi.mock("./services/runtimeState.js", () => ({ RuntimeState: class { buildDecisionContext = vi.fn(() => ({})); } }));
vi.mock("./services/eventDetector.js", () => ({ EventDetector: class { heartbeat = vi.fn(); } }));
vi.mock("./services/marketIngestor.js", () => ({ MarketIngestor: class { start = vi.fn(); } }));
vi.mock("./services/newsIngestor.js", () => ({ NewsIngestor: class { start = vi.fn(); } }));
vi.mock("./services/onchainIngestor.js", () => ({ OnchainIngestor: class { start = vi.fn(); } }));
vi.mock("./http/server.js", () => ({ createHttpServer: vi.fn(async (_runtime, _port, trigger) => { mocks.trigger = trigger; return { start: vi.fn() }; }) }));
let signalListeners: Record<string, Function[]>;
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks();
  signalListeners = Object.fromEntries((["SIGINT", "SIGTERM"] as const).map((name) => [name, process.listeners(name)]));
  mocks.acquired.mockResolvedValue(true); mocks.renewed.mockResolvedValue(true); mocks.released.mockResolvedValue(undefined);
  await import("./index.js"); await vi.advanceTimersByTimeAsync(0);
});
afterEach(() => {
  for (const name of ["SIGINT", "SIGTERM"] as const) for (const listener of process.listeners(name)) if (!signalListeners[name]!.includes(listener)) process.removeListener(name, listener);
  vi.useRealTimers();
});
it("keeps actual entrypoint evaluations single-flight after 55 seconds", async () => {
  let resolve!: () => void;
  mocks.decide.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
  const first = mocks.trigger!(); await vi.advanceTimersByTimeAsync(60000);
  await mocks.trigger!();
  expect(mocks.decide).toHaveBeenCalledOnce();
  expect(mocks.renewed).toHaveBeenCalled();
  resolve(); await first;
  expect(mocks.execute).toHaveBeenCalledOnce();
  expect(mocks.released).toHaveBeenCalledOnce();
});
it("does not execute a completed model decision after ownership loss", async () => {
  mocks.renewed.mockResolvedValue(false); mocks.decide.mockResolvedValue({});
  await mocks.trigger!();
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalled();
  expect(mocks.released).toHaveBeenCalledOnce();
});
