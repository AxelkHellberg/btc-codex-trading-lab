import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPositionMode: vi.fn(), store: vi.fn(), redis: vi.fn(), broker: vi.fn(), error: vi.fn()
}));
vi.mock("../config.js", async (original) => {
  const { config } = await original<typeof import("../config.js")>();
  return { config: { ...config, tradingMode: "live" } };
});
vi.mock("../infra/binance/binanceFuturesClient.js", () => ({
  BinanceFuturesClient: class { getPositionMode = mocks.getPositionMode; }
}));
vi.mock("../infra/store/postgresStateStore.js", () => ({ PostgresStateStore: mocks.store }));
vi.mock("../infra/store/redisHotStore.js", () => ({ RedisHotStore: mocks.redis }));
vi.mock("./brokers.js", () => ({ LiveBroker: mocks.broker, PaperBroker: mocks.broker }));
vi.mock("../logger.js", () => ({ logger: { error: mocks.error } }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("live entrypoint startup gate", () => {
  it.each(["hedge", "unavailable"])("stops %s mode before stores and execution services are created", async (outcome) => {
    vi.resetModules();
    if (outcome === "hedge") mocks.getPositionMode.mockResolvedValueOnce(true);
    else mocks.getPositionMode.mockRejectedValueOnce(new Error("mode unavailable"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("../index.js");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(mocks.getPositionMode).toHaveBeenCalledOnce();
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.redis).not.toHaveBeenCalled();
    expect(mocks.broker).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledOnce();
  });
});
