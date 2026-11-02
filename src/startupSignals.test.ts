import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn(), pgClose: vi.fn(), redisClose: vi.fn(), httpFactory: vi.fn(),
  httpStart: vi.fn(), httpStop: vi.fn(), marketStart: vi.fn(), marketStop: vi.fn(),
  newsStart: vi.fn(), newsStop: vi.fn(), onchainStart: vi.fn(), onchainStop: vi.fn(),
  info: vi.fn(), error: vi.fn(), warn: vi.fn()
}));
vi.mock("./logger.js", () => ({ logger: { info: mocks.info, error: mocks.error, warn: mocks.warn } }));
vi.mock("./infra/store/postgresStateStore.js", () => ({ PostgresStateStore: class { init = mocks.init; close = mocks.pgClose; } }));
vi.mock("./infra/store/redisHotStore.js", () => ({ RedisHotStore: class { close = mocks.redisClose; } }));
vi.mock("./http/server.js", () => ({ createHttpServer: mocks.httpFactory }));
vi.mock("./services/marketIngestor.js", () => ({ MarketIngestor: class { start = mocks.marketStart; stop = mocks.marketStop; } }));
vi.mock("./services/newsIngestor.js", () => ({ NewsIngestor: class { start = mocks.newsStart; stop = mocks.newsStop; } }));
vi.mock("./services/onchainIngestor.js", () => ({ OnchainIngestor: class { start = mocks.onchainStart; stop = mocks.onchainStop; } }));
vi.mock("./infra/binance/binanceFuturesClient.js", () => ({ BinanceFuturesClient: class {} }));
vi.mock("./infra/notifier/telegramNotifier.js", () => ({ TelegramNotifier: class {} }));
vi.mock("./services/codexDecisionWorker.js", () => ({ CodexDecisionWorker: class {} }));
vi.mock("./services/brokers.js", () => ({ LiveBroker: class {}, PaperBroker: class {} }));

const signals = new Map<string, () => void>();
let exit: MockInstance<typeof process.exit>;
const deferred = () => {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>(r => { resolve = r; }); return { promise, resolve };
};
beforeEach(() => {
  vi.resetModules(); signals.clear();
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.init.mockResolvedValue(undefined);
  mocks.httpFactory.mockResolvedValue({ start: mocks.httpStart, stop: mocks.httpStop });
  mocks.httpStart.mockResolvedValue(undefined); mocks.marketStart.mockResolvedValue(undefined);
  mocks.newsStart.mockResolvedValue(undefined); mocks.onchainStart.mockResolvedValue(undefined);
  const originalOn = process.on.bind(process);
  vi.spyOn(process, "on").mockImplementation(((event: string, listener: (...args: any[]) => void) => {
    if (event === "SIGINT" || event === "SIGTERM") { signals.set(event, listener); return process; }
    return originalOn(event as never, listener);
  }) as typeof process.on);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const assertStopped = async () => {
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  expect(mocks.pgClose).toHaveBeenCalledOnce(); expect(mocks.redisClose).toHaveBeenCalledOnce();
  expect(mocks.info).not.toHaveBeenCalledWith(expect.anything(), "BTC Codex trader started");
};

describe("entrypoint startup signal wiring", () => {
  it("registers signals before awaiting Postgres and prevents later startup", async () => {
    const pending = deferred(); mocks.init.mockReturnValue(pending.promise);
    await import("./index.js");
    expect(signals.has("SIGTERM")).toBe(true); expect(signals.has("SIGINT")).toBe(true);
    signals.get("SIGTERM")!(); signals.get("SIGINT")!();
    expect(mocks.pgClose).not.toHaveBeenCalled();
    pending.resolve(); await assertStopped();
    expect(mocks.httpFactory).not.toHaveBeenCalled(); expect(mocks.marketStart).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("owns an HTTP server returned after cancellation without starting it", async () => {
    const pending = deferred(); mocks.httpFactory.mockReturnValue(pending.promise);
    await import("./index.js"); await vi.waitFor(() => expect(mocks.httpFactory).toHaveBeenCalled());
    signals.get("SIGTERM")!(); pending.resolve({ start: mocks.httpStart, stop: mocks.httpStop });
    await assertStopped(); expect(mocks.httpStop).toHaveBeenCalledOnce();
    expect(mocks.httpStart).not.toHaveBeenCalled(); expect(mocks.marketStart).not.toHaveBeenCalled();
  });

  it("stops the in-flight ingestor after settlement and skips following ingestors", async () => {
    const pending = deferred(); mocks.marketStart.mockReturnValue(pending.promise);
    await import("./index.js"); await vi.waitFor(() => expect(mocks.marketStart).toHaveBeenCalled());
    signals.get("SIGINT")!(); expect(mocks.marketStop).not.toHaveBeenCalled();
    pending.resolve(); await assertStopped();
    expect(mocks.marketStop).toHaveBeenCalledOnce(); expect(mocks.httpStop).toHaveBeenCalledOnce();
    expect(mocks.newsStart).not.toHaveBeenCalled(); expect(mocks.onchainStart).not.toHaveBeenCalled();
  });
});
