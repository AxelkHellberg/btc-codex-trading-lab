import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { RedisHotStore } from "./redisHotStore.js";

// A small RESP peer exercises the installed client without a Redis service.
async function peer(hold: string[] = []) {
  const sockets = new Set<net.Socket>();
  const commands: string[][] = [];
  let connections = 0;
  let denyLock = false;
  const server = net.createServer(socket => {
    connections++;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const line = buffer.indexOf("\r\n");
        if (line < 0) return;
        const count = Number(buffer.subarray(1, line).toString());
        let cursor = line + 2;
        const command: string[] = [];
        for (let i = 0; i < count; i++) {
          const end = buffer.indexOf("\r\n", cursor);
          if (end < 0) return;
          const length = Number(buffer.subarray(cursor + 1, end).toString());
          if (buffer.length < end + 2 + length + 2) return;
          command.push(buffer.subarray(end + 2, end + 2 + length).toString());
          cursor = end + 2 + length + 2;
        }
        buffer = buffer.subarray(cursor);
        commands.push(command);
        const name = command[0]!.toLowerCase();
        if (hold.includes(name)) continue;
        if (name === "info") {
          const info = "redis_version:7.0.0\r\nloading:0\r\nrole:master\r\n";
          socket.write(`$${Buffer.byteLength(info)}\r\n${info}\r\n`);
        } else if (name === "eval") {
          socket.write(":1\r\n");
        } else if (name === "set" && command.includes("NX") && denyLock) {
          socket.write("$-1\r\n");
        } else {
          socket.write("+OK\r\n");
          if (name === "quit") socket.end();
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const warn = vi.fn();
  const store = new RedisHotStore(`redis://127.0.0.1:${(server.address() as AddressInfo).port}`, { warn } as unknown as Logger);
  const redis = (store as unknown as { redis: Redis }).redis;
  // Prevent the baseline implementation's unbounded waits from hanging tests.
  async function bounded(operation: Promise<unknown>) {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation.then(value => ({ value }), error => ({ error })),
        new Promise<{ pending: true }>(resolve => { timer = setTimeout(() => resolve({ pending: true }), 5_700); })
      ]);
    } finally { clearTimeout(timer); }
  }
  return {
    store, redis, commands, warn, bounded,
    get connections() { return connections; },
    denyLock() { denyLock = true; },
    async ready() {
      if (redis.status === "ready") return;
      await new Promise<void>(resolve => redis.once("ready", resolve));
    },
    async cleanup() {
      redis.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

describe("runtime Redis operation deadlines", () => {
  it("waits for readiness and preserves healthy JSON, lock and release behavior", async () => {
    const p = await peer();
    try {
      await p.store.setJson("snapshot", { price: 100 }, 30);
      expect(await p.store.acquireLock("decision", "token", 1_000)).toBe(true);
      p.denyLock();
      expect(await p.store.acquireLock("decision", "other", 1_000)).toBe(false);
      await p.store.releaseLock("decision", "token");
      expect(p.commands).toContainEqual(["set", "snapshot", '{"price":100}', "EX", "30"]);
      await p.store.close();
      await expect.poll(() => p.redis.status).toBe("end");
    } finally { await p.cleanup(); }
  });

  it.each(["set", "eval"])("rejects a silent %s and never replays or grants a late lock", async command => {
    const p = await peer([command]);
    try {
      await p.ready();
      const outcome = await p.bounded(command === "set"
        ? p.store.acquireLock("decision", "token", 20_000)
        : p.store.releaseLock("decision", "token"));
      expect(outcome).toHaveProperty("error");
      await expect.poll(() => p.redis.status).toBe("end");
      await expect(p.store.acquireLock("decision", "next", 1_000)).rejects.toThrow();
      expect(p.commands.filter(c => c[0] === command)).toHaveLength(1);
      expect(p.connections).toBe(1);
      await p.store.close();
    } finally { await p.cleanup(); }
  }, 10_000);

  it("bounds readiness stalls and does not send a queued write later", async () => {
    const p = await peer(["info"]);
    try {
      const outcome = await p.bounded(p.store.setJson("snapshot", { price: 100 }));
      expect(outcome).toHaveProperty("error");
      await expect.poll(() => p.redis.status).toBe("end");
      expect(p.commands.filter(c => c[0] === "set")).toHaveLength(0);
    } finally { await p.cleanup(); }
  }, 10_000);

  it("bounds QUIT, disconnects and keeps shutdown diagnostics fixed", async () => {
    const p = await peer(["quit"]);
    try {
      await p.ready();
      const outcome = await p.bounded(p.store.close());
      expect(outcome).toEqual({ value: undefined });
      await expect.poll(() => p.redis.status).toBe("end");
      expect(p.warn).toHaveBeenCalledWith("Redis shutdown failed; connection disconnected");
      await p.store.close();
      expect(p.commands.filter(c => c[0] === "quit")).toHaveLength(1);
    } finally { await p.cleanup(); }
  }, 10_000);
});
