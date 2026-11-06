import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisHotStore } from "./redisHotStore.js";

// Only an explicitly supplied disposable local Unix socket is supported.
const socket = process.env.TEST_REDIS_SOCKET;
describe.skipIf(!socket)("owned lease renewal with disposable Redis", () => {
  let store: RedisHotStore; let probe: Redis; let key: string;
  beforeEach(() => {
    if (!socket?.startsWith("/")) throw new Error("TEST_REDIS_SOCKET must be an absolute local socket path");
    store = new RedisHotStore(socket, { warn: vi.fn() } as unknown as Logger);
    probe = new Redis(socket, { maxRetriesPerRequest: 1, retryStrategy: () => null, commandTimeout: 1000, connectTimeout: 1000 });
    probe.on("error", () => {}); key = `test:renew:${randomUUID()}`;
  });
  afterEach(async () => { try { await probe.del(key); } finally { probe.disconnect(); await store.close(); } });
  it("extends only the currently matching token", async () => {
    expect(await store.acquireLock(key, "owner", 300)).toBe(true);
    expect(await store.renewLock(key, "owner", 1000)).toBe(true);
    expect(await probe.pttl(key)).toBeGreaterThan(500);
    expect(await probe.get(key)).toBe("owner");
  });
  it("does not extend or delete a different token", async () => {
    await store.acquireLock(key, "current", 3000); const before = await probe.pttl(key);
    expect(await store.renewLock(key, "stale", 10000)).toBe(false);
    expect(await probe.pttl(key)).toBeLessThanOrEqual(before);
    await store.releaseLock(key, "stale"); expect(await probe.get(key)).toBe("current");
  });
  it("cannot revive an expired key or replace its successor", async () => {
    await store.acquireLock(key, "old", 30);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await store.renewLock(key, "old", 3000)).toBe(false);
    expect(await store.acquireLock(key, "new", 3000)).toBe(true);
    expect(await store.renewLock(key, "old", 10000)).toBe(false);
    await store.releaseLock(key, "old"); expect(await probe.get(key)).toBe("new");
  });
});
