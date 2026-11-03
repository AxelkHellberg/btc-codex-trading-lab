import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ pools: [] as { query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn>; options: unknown }[] }));
vi.mock("pg", () => ({ Pool: class { query = vi.fn().mockResolvedValue({ rows: [] }); end = vi.fn().mockResolvedValue(undefined); on = vi.fn(); constructor(options: unknown) { mocks.pools.push(Object.assign(this, { options })); } } }));
import { PostgresStateStore } from "./postgresStateStore.js";
const logger = { warn: vi.fn() } as unknown as Logger;
afterEach(() => { mocks.pools.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); });
it.each([0, -1, 1.5, Infinity, NaN, 8761])("rejects invalid retention hours %s", hours => {
  expect(() => new PostgresStateStore("postgres://unused", logger, { marketHours: hours, otherHours: 168 })).toThrow("whole hours");
});
describe("snapshot cleanup lifecycle", () => {
  it("keeps ingestion independent and prevents overlap while cleanup is stalled", async () => {
    vi.useFakeTimers();
    let resume!: () => void;
    const store = new PostgresStateStore("postgres://unused", logger, { marketHours: 24, otherHours: 168 });
    // Initialize before the first async cleanup pass can advance beyond its first await.
    await store.init();
    const cleanup = mocks.pools[1]!;
    cleanup.query.mockImplementation(() => new Promise<void>(resolve => { resume = resolve; }));
    await vi.advanceTimersByTimeAsync(60_000);
    const before = cleanup.query.mock.calls.length;
    await store.saveSnapshot("market", { price: 1 });
    expect(mocks.pools[0]!.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO snapshots"), expect.any(Array));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(cleanup.query.mock.calls.length).toBe(before);
    const closing = store.close();
    resume(); await closing;
    expect(cleanup.end).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(cleanup.query.mock.calls.length).toBe(before);
  });
  it("logs cleanup failures and retries later without unhandled rejections", async () => {
    vi.useFakeTimers();
    const warn = vi.fn();
    const store = new PostgresStateStore("postgres://unused", { warn } as unknown as Logger, { marketHours: 24, otherHours: 168 });
    await store.init(); await vi.advanceTimersByTimeAsync(0);
    const cleanup = mocks.pools[1]!;
    cleanup.query.mockRejectedValueOnce(new Error("private connection data"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(warn).toHaveBeenCalledWith("Snapshot retention cleanup failed; will retry on the next interval");
    const before = cleanup.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cleanup.query.mock.calls.length).toBe(before + 5);
    expect(cleanup.options).toMatchObject({ max: 1, connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 3000 });
    await store.close();
  });
  it("repeated initialization owns just one cleanup interval", async () => {
    vi.useFakeTimers();
    const store = new PostgresStateStore("postgres://unused", logger, { marketHours: 24, otherHours: 168 });
    await store.init(); await store.init(); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.pools).toHaveLength(2);
    const cleanup = mocks.pools[1]!;
    const before = cleanup.query.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cleanup.query.mock.calls.length).toBe(before + 5);
    await store.close();
  });
});
