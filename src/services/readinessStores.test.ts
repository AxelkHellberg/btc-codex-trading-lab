import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), ping: vi.fn() }));
vi.mock("pg", () => ({ Pool: class { query = mocks.query; } }));
vi.mock("ioredis", () => ({ Redis: class { ping = mocks.ping; } }));
import { PostgresStateStore } from "../infra/store/postgresStateStore.js";
import { RedisHotStore } from "../infra/store/redisHotStore.js";
beforeEach(() => vi.resetAllMocks());
const logger = {} as Logger;
describe("read-only dependency probes", () => {
  it("uses a read-only SELECT and propagates Postgres failure", async () => {
    const store = new PostgresStateStore("unused", logger); mocks.query.mockResolvedValueOnce({});
    await store.checkHealth(); expect(mocks.query).toHaveBeenCalledWith("SELECT 1");
    mocks.query.mockRejectedValueOnce(new Error("offline")); await expect(store.checkHealth()).rejects.toThrow("offline");
  });
  it("accepts only Redis PONG and propagates transport failure", async () => {
    const store = new RedisHotStore("unused", logger); mocks.ping.mockResolvedValueOnce("PONG");
    await store.checkHealth(); mocks.ping.mockResolvedValueOnce("not-pong");
    await expect(store.checkHealth()).rejects.toThrow("readiness probe failed");
    mocks.ping.mockRejectedValueOnce(new Error("offline")); await expect(store.checkHealth()).rejects.toThrow("offline");
    expect(mocks.ping).toHaveBeenCalledTimes(3);
  });
});
