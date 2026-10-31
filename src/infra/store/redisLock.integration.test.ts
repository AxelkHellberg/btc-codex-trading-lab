import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RedisHotStore } from "./redisHotStore.js";

// Opt in only against a disposable loopback Redis; never use application config.
const url = process.env.REDIS_LOCK_TEST_URL;
if (url) {
  const target = new URL(url);
  if (target.protocol !== "redis:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
    throw new Error("REDIS_LOCK_TEST_URL must identify a disposable loopback Redis");
  }
}

describe.skipIf(!url)("Redis lock ownership against a real Redis server", () => {
  let inspector: Redis;
  let owner: RedisHotStore;
  let contender: RedisHotStore;
  let key: string;

  beforeEach(() => {
    key = `lock-test:${randomUUID()}`;
    inspector = new Redis(url!, { connectTimeout: 1_000, commandTimeout: 1_000, retryStrategy: () => null });
    // Test failures must not emit unhandled client error events.
    inspector.on("error", () => {});
    const logger = { warn: vi.fn() } as unknown as Logger;
    owner = new RedisHotStore(url!, logger);
    contender = new RedisHotStore(url!, logger);
  });

  afterEach(async () => {
    try {
      // Only the unique key created by this test is removed, including failures.
      await inspector.del(key);
    } finally {
      await Promise.allSettled([owner.close(), contender.close()]);
      inspector.disconnect();
    }
  });

  it("admits one concurrent owner and gives the lock a bounded lifetime", async () => {
    const tokens = [randomUUID(), randomUUID()];
    const results = await Promise.all([
      owner.acquireLock(key, tokens[0]!, 10_000),
      contender.acquireLock(key, tokens[1]!, 10_000)
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await inspector.get(key)).toBe(tokens[results.indexOf(true)]);
    expect(await inspector.pttl(key)).toBeGreaterThan(0);
    expect(await inspector.pttl(key)).toBeLessThanOrEqual(10_000);
  });

  it("does not let a non-owner delete or extend the current owner's lock", async () => {
    expect(await owner.acquireLock(key, "owner", 10_000)).toBe(true);
    const ttl = await inspector.pttl(key);
    expect(await contender.acquireLock(key, "stranger", 30_000)).toBe(false);
    await contender.releaseLock(key, "stranger");
    expect(await inspector.get(key)).toBe("owner");
    expect(await inspector.pttl(key)).toBeLessThanOrEqual(ttl);
    const transport = (owner as unknown as { redis: Redis }).redis;
    const commands = vi.spyOn(transport, "sendCommand");
    await owner.releaseLock(key, "owner");
    expect(commands.mock.calls.map(([command]) => command.name)).toEqual(["eval"]);
    expect(await inspector.get(key)).toBeNull();
    expect(await contender.acquireLock(key, "stranger", 10_000)).toBe(true);
  });

  it("preserves a new owner's lock after the previous lease expires", async () => {
    expect(await owner.acquireLock(key, "old-owner", 100)).toBe(true);
    await expect.poll(() => inspector.get(key), { timeout: 2_000 }).toBeNull();
    expect(await contender.acquireLock(key, "new-owner", 10_000)).toBe(true);
    await owner.releaseLock(key, "old-owner");
    expect(await inspector.get(key)).toBe("new-owner");
    await contender.releaseLock(key, "new-owner");
    expect(await inspector.get(key)).toBeNull();
  });

  it("releases an absent lock harmlessly and preserves unrelated keys", async () => {
    await owner.releaseLock(key, "absent");
    expect(await inspector.exists(key)).toBe(0);
    expect(await owner.acquireLock(key, "token", 10_000)).toBe(true);
    await owner.releaseLock(`${key}:absent`, "token");
    expect(await inspector.get(key)).toBe("token");
  });
});
