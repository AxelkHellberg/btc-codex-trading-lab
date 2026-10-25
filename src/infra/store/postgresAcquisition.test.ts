import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Pool } from "pg";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { PostgresStateStore } from "./postgresStateStore.js";

function packet(type: string, payload: Buffer) {
  const header = Buffer.alloc(5);
  header.write(type);
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

async function peer(respond: boolean) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let startup = true;
    let buffer = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= (startup ? 4 : 5)) {
        const length = buffer.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (buffer.length < length) return;
        const type = startup ? "startup" : String.fromCharCode(buffer[0]!);
        buffer = buffer.subarray(length);
        startup = false;
        if (!respond) continue;
        if (type === "startup") {
          socket.write(Buffer.concat([packet("R", Buffer.alloc(4)), packet("Z", Buffer.from("I"))]));
        } else if (type === "Q") {
          socket.write(Buffer.concat([packet("C", Buffer.from("CREATE TABLE\0")), packet("Z", Buffer.from("I"))]));
        } else if (type === "X") {
          socket.end();
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const store = new PostgresStateStore(
    `postgres://test:test@127.0.0.1:${(server.address() as AddressInfo).port}/test?sslmode=disable`,
    { warn: vi.fn() } as unknown as Logger
  );
  const pool = (store as unknown as { pool: Pool }).pool;
  return {
    store, pool,
    async close() {
      for (const socket of sockets) socket.destroy();
      await store.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

async function bounded(promise: Promise<unknown>) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => "resolved", error => error),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("still pending"), 5_700); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("Postgres connection acquisition", () => {
  it("rejects initialization when a TCP peer never completes its handshake", async () => {
    const fixture = await peer(false);
    try {
      const result = await bounded(fixture.store.init());
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/connection timeout|timeout exceeded/i);
    } finally {
      await fixture.close();
    }
  }, 10_000);

  it("initializes against a healthy protocol peer and uses a finite default", async () => {
    const fixture = await peer(true);
    try {
      expect(fixture.pool.options.connectionTimeoutMillis).toBe(5_000);
      await fixture.store.init();
      expect(fixture.pool.idleCount).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("bounds waiters when every pool client is checked out", async () => {
    const fixture = await peer(true);
    fixture.pool.options.max = 1;
    const client = await fixture.pool.connect();
    try {
      const result = await bounded(fixture.store.init());
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/timeout exceeded/i);
      expect(fixture.pool.waitingCount).toBe(0);
      client.release();
      await fixture.store.init();
    } finally {
      if (fixture.pool.idleCount === 0) client.release();
      await fixture.close();
    }
  }, 10_000);
});
