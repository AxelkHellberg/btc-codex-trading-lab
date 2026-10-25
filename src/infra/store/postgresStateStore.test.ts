import type { Pool } from "pg";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostgresStateStore } from "./postgresStateStore.js";

afterEach(() => vi.restoreAllMocks());

describe("PostgresStateStore pool failures", () => {
  const setup = () => {
    const logger = { warn: vi.fn() };
    const store = new PostgresStateStore(
      "postgres://unused:unused@127.0.0.1:1/unused",
      logger as unknown as Logger
    );
    const pool = (store as unknown as { pool: Pool }).pool;
    return { store, pool, logger };
  };

  it("observes idle-client errors before init without logging the client", async () => {
    const { store, pool, logger } = setup();
    const error = new Error("simulated idle connection failure");
    const client = { connectionParameters: { password: "must-not-be-logged" } };
    try {
      expect(() => pool.emit("error", error, client)).not.toThrow();
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith({ error }, "Idle Postgres client error");
    } finally {
      await store.close();
    }
  });

  it("continues to reject failed writes to their callers", async () => {
    const { store, pool, logger } = setup();
    const error = new Error("query failed");
    vi.spyOn(pool, "query").mockRejectedValueOnce(error as never);
    try {
      await expect(store.saveSnapshot("market", {})).rejects.toBe(error);
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await store.close();
    }
  });
});
