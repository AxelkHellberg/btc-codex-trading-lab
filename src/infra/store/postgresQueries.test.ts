import { createServer, type Socket } from "node:net";

import type { Pool } from "pg";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostgresStateStore } from "./postgresStateStore.js";

const logger = { warn: vi.fn() } as unknown as Logger;
const frame = (tag: string, body = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(5);
  header.write(tag);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
};
const ready = frame("Z", Buffer.from("I"));

// A loopback protocol peer, not a PostgreSQL server. It authenticates the real
// pg driver, then either replies or withholds replies after receiving a query.
const createPeer = async () => {
  const sockets = new Set<Socket>();
  const queries: string[] = [];
  let mode: "silent" | "success" | "error" = "silent";
  let queryReceived: (() => void) | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let started = false;
    let extended = false;
    const reply = () => {
      queryReceived?.();
      queryReceived = undefined;
      if (mode === "silent") return;
      if (mode === "error") {
        socket.write(Buffer.concat([
          frame("E", Buffer.from("SERROR\0C57014\0Mfixture query failure\0\0")), ready
        ]));
      } else {
        socket.write(Buffer.concat([
          ...(extended ? [frame("1"), frame("2"), frame("n")] : []),
          frame("C", Buffer.from("INSERT 0 1\0")), ready
        ]));
      }
      extended = false;
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!started) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        buffer = buffer.subarray(buffer.readInt32BE(0));
        started = true;
        socket.write(Buffer.concat([frame("R", Buffer.alloc(4)), ready]));
      }
      while (buffer.length >= 5) {
        const length = buffer.readInt32BE(1) + 1;
        if (buffer.length < length) return;
        const tag = String.fromCharCode(buffer[0]!);
        const body = buffer.subarray(5, length);
        buffer = buffer.subarray(length);
        if (tag === "P") {
          extended = true;
          queries.push(body.toString().split("\0")[1]!);
        }
        if (tag === "Q") {
          queries.push(body.toString());
          reply();
        }
        if (tag === "S") reply();
        if (tag === "X") socket.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return {
    url: `postgresql://fixture@127.0.0.1:${address.port}/fixture?sslmode=disable`,
    queries,
    setMode: (value: typeof mode) => { mode = value; },
    nextQuery: () => new Promise<void>((resolve) => { queryReceived = resolve; }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
};

describe("PostgresStateStore active query deadlines", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each(["", "&query_timeout=60000", "&query_timeout=0"])("bounds a silent write with URL override '%s' and releases its client without retry", async (override) => {
    const peer = await createPeer();
    // Connection-string defaults must not lengthen or shorten this budget.
    const store = new PostgresStateStore(`${peer.url}${override}`, logger);
    const pool = (store as unknown as { pool: Pool }).pool;
    let outcome: unknown = "pending";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const received = peer.nextQuery();
      const write = store.saveSnapshot("fixture", {}).then(
        () => { outcome = "resolved"; }, (error: unknown) => { outcome = error; }
      );
      await received;
      expect(pool.totalCount).toBe(1);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(9_000);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1_001);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/query read timeout/i);
      await write;
      expect(pool.totalCount).toBe(0);
      await store.close();
      expect(peer.queries).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await peer.close();
      await store.close();
    }
  });

  it("keeps healthy schema, snapshot, decision, trade, and heartbeat writes working", async () => {
    const peer = await createPeer();
    peer.setMode("success");
    const store = new PostgresStateStore(peer.url, logger);
    try {
      await store.init();
      await store.saveSnapshot("fixture", { value: 1 });
      await store.saveDecision({
        decisionId: "fixture", approved: false, mode: "paper", trigger: {},
        context: {}, signal: {}, reasons: [], createdAt: 1000
      } as Parameters<typeof store.saveDecision>[0]);
      await store.saveTrade({
        tradeId: "fixture", mode: "paper", action: "LONG", side: "BUY",
        quantity: 1, leverage: 1, entryPrice: 100, confidence: 1, status: "open",
        details: {}, createdAt: 1000, updatedAt: 1000
      } as Parameters<typeof store.saveTrade>[0]);
      await store.heartbeat("fixture", {});
      expect(peer.queries).toHaveLength(5);
      expect(peer.queries[0]).toContain("CREATE TABLE IF NOT EXISTS snapshots");
      expect(peer.queries.slice(1).join("\n")).toContain("INSERT INTO heartbeats");
    } finally {
      await store.close();
      await peer.close();
    }
  });

  it("propagates SQL rejection without retry and allows a new healthy connection", async () => {
    const peer = await createPeer();
    peer.setMode("error");
    const store = new PostgresStateStore(peer.url, logger);
    const pool = (store as unknown as { pool: Pool }).pool;
    try {
      await expect(store.heartbeat("fixture", {})).rejects.toMatchObject({ code: "57014", message: "fixture query failure" });
      expect(pool.totalCount).toBe(0);
      expect(peer.queries).toHaveLength(1);
      peer.setMode("success");
      await store.saveSnapshot("fixture", {});
      expect(peer.queries).toHaveLength(2);
    } finally {
      await store.close();
      await peer.close();
    }
  });
});
