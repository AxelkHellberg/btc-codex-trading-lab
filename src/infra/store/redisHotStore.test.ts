import { beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = {
  del: vi.fn(),
  eval: vi.fn(),
  get: vi.fn(),
  quit: vi.fn(),
  set: vi.fn()
};

vi.mock("ioredis", () => ({
  Redis: vi.fn(() => redisMock)
}));

import { RedisHotStore } from "./redisHotStore.js";

describe("RedisHotStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.eval.mockResolvedValue(1);
    redisMock.quit.mockResolvedValue("OK");
    redisMock.set.mockResolvedValue("OK");
  });

  it("releases a lock with one atomic compare-and-delete script", async () => {
    const logger = { warn: vi.fn() } as never;
    const store = new RedisHotStore("redis://localhost:6379", logger);

    await store.releaseLock("decision-loop", "token-123");

    expect(redisMock.eval).toHaveBeenCalledTimes(1);
    expect(redisMock.eval).toHaveBeenCalledWith(expect.stringContaining('redis.call("GET", KEYS[1])'), 1, "decision-loop", "token-123");
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });
});
