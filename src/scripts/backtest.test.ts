import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  client: vi.fn(),
  broker: vi.fn(),
  logger: { info: vi.fn(), error: vi.fn() }
}));

vi.mock("../infra/binance/binanceFuturesClient.js", () => ({ BinanceFuturesClient: mocks.client }));
vi.mock("../services/brokers.js", () => ({ PaperBroker: mocks.broker }));
vi.mock("../logger.js", () => ({ logger: mocks.logger }));

describe("backtest CLI input validation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("BACKTEST_DAYS", "90");
    vi.stubEnv("BACKTEST_INITIAL_BALANCE", "10000");
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(["BACKTEST_DAYS", "BACKTEST_INITIAL_BALANCE"])(
    "rejects invalid %s before creating a client or paper broker",
    async (variable) => {
      vi.stubEnv(variable, "not-a-number");

      await import("./backtest.js");

      await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
      expect(mocks.client).not.toHaveBeenCalled();
      expect(mocks.broker).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(mocks.logger.info).not.toHaveBeenCalled();
      expect(mocks.logger.error).toHaveBeenCalledWith(
        { err: expect.objectContaining({ message: `${variable} must be a finite number greater than zero` }) },
        "Backtest failed"
      );
    }
  );
});
