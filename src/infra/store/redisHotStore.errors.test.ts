import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

type RedisDouble = EventEmitter & {
  set: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};
const doubles = vi.hoisted(() => ({ clients: [] as RedisDouble[] }));
vi.mock("ioredis", () => ({
  Redis: class extends EventEmitter {
    set = vi.fn().mockResolvedValue("OK");
    eval = vi.fn().mockResolvedValue(1);
    quit = vi.fn().mockResolvedValue("OK");
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn();
    constructor() { super(); doubles.clients.push(this); }
  }
}));

import { RedisHotStore } from "./redisHotStore.js";

describe("RedisHotStore connection errors", () => {
  beforeEach(() => { doubles.clients.length = 0; });

  function setup() {
    const warn = vi.fn();
    const store = new RedisHotStore("redis://user:secret@redis.invalid", { warn } as unknown as Logger);
    return { store, warn, client: doubles.clients[0]! };
  }

  it("observes asynchronous connection failures through the project logger", () => {
    const { client, warn } = setup();
    const error = Object.assign(new Error("redis://user:secret@redis.invalid private-payload"), {
      code: "ECONNREFUSED", command: { args: ["private-payload"] }
    });
    expect(() => client.emit("error", error)).not.toThrow();
    expect(warn).toHaveBeenCalledWith({ code: "ECONNREFUSED" }, "Redis connection error");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret|private-payload|redis\.invalid/);
  });

  it.each([new Error("secret"), { code: "secret" }, null])(
    "uses a fixed fallback for unrecognized error metadata: %j", (error) => {
      const { client, warn } = setup();
      expect(() => client.emit("error", error)).not.toThrow();
      expect(warn).toHaveBeenCalledWith({ code: "UNKNOWN" }, "Redis connection error");
    }
  );

  it("preserves command rejections after a transport error", async () => {
    const { store, client } = setup();
    client.emit("error", Object.assign(new Error("transport failed"), { code: "ETIMEDOUT" }));
    const failure = new Error("command failed");
    client.set.mockRejectedValue(failure);
    client.eval.mockRejectedValue(failure);
    await expect(store.setJson("snapshot", { value: 1 })).rejects.toBe(failure);
    await expect(store.acquireLock("lock", "token", 1000)).rejects.toThrow("Redis store unavailable");
    await expect(store.releaseLock("lock", "token")).rejects.toThrow("Redis store unavailable");
    expect(client.disconnect).toHaveBeenCalledWith(false);
    expect(client.eval).not.toHaveBeenCalled();
  });

  it("retains normal writes, lock acquisition and shutdown", async () => {
    const { store, client, warn } = setup();
    await store.setJson("snapshot", { value: 1 }, 30);
    expect(client.set).toHaveBeenCalledWith("snapshot", '{"value":1}', "EX", 30);
    await expect(store.acquireLock("lock", "token", 1000)).resolves.toBe(true);
    expect(client.set).toHaveBeenCalledWith("lock", "token", "PX", 1000, "NX");
    await store.close();
    expect(client.quit).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });
});
