import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DecisionContext, ExecutionPlan, PersistedDecisionRecord, PersistedTradeRecord } from "../../domain/types.js";
import { PostgresStateStore } from "./postgresStateStore.js";

// Explicit opt-in only. Every run owns a random schema, never public tables.
const connectionString = process.env.POSTGRES_TEST_URL;
const schema = `contract_${randomUUID().replaceAll("-", "")}`;
const suite = connectionString ? describe : describe.skip;
suite("PostgresStateStore real database contract", () => {
  let admin: Pool;
  let query: Pool;
  let store: PostgresStateStore;
  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("POSTGRES_TEST_URL must point to a disposable local PostgreSQL instance");
    }
    admin = new Pool({ connectionString, connectionTimeoutMillis: 2_000, query_timeout: 5_000 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`);
    query = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 2_000, query_timeout: 5_000 });
    store = new PostgresStateStore(url.toString(), pino({ enabled: false }));
    await store.init();
  }, 10_000);
  afterAll(async () => {
    try { await store?.close(); } finally {
      await query?.end();
      try { await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin?.end(); }
    }
  });

  it("initializes an empty schema and initializes it again without losing rows", async () => {
    await store.saveSnapshot("market", { price: 100_000, nested: { ok: true }, array: [1, null] });
    await store.init();
    const result = await query.query("SELECT kind, payload, created_at FROM snapshots");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ kind: "market", payload: { price: 100_000, nested: { ok: true }, array: [1, null] } });
    expect(result.rows[0].created_at).toBeInstanceOf(Date);
    const tables = await query.query("SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name", [schema]);
    expect(tables.rows.map((row) => row.table_name)).toEqual(["decisions", "heartbeats", "snapshots", "trades"]);
  });
  it("upserts a decision by ID with latest JSON fields and optional plan", async () => {
    const record: PersistedDecisionRecord = {
      decisionId: "decision-1", approved: false, mode: "paper",
      trigger: { reason: "minute_recheck", priority: 0, details: "contract", triggeredAt: 1_700_000_000_123 },
      context: { fixture: "original" } as unknown as DecisionContext,
      signal: { bias: "FLAT", confidence: 0.5, setup_type: "continuation", holding_horizon_minutes: 1, reasoning_summary: "contract" },
      reasons: ["original"], createdAt: 1_700_000_000_123
    };
    await store.saveDecision(record);
    expect((await query.query("SELECT plan FROM decisions WHERE decision_id=$1", [record.decisionId])).rows[0].plan).toBeNull();
    // Persistence treats a plan as JSONB; this marker tests null-to-object upsert.
    const plan = { action: "LONG", quantity: 0.02, fixture: "latest plan" } as unknown as ExecutionPlan;
    await store.saveDecision({ ...record, approved: true, plan, context: { fixture: "latest" } as unknown as DecisionContext, reasons: ["latest"], signal: { ...record.signal, confidence: 0.9 } });
    const { rows } = await query.query("SELECT * FROM decisions WHERE decision_id=$1", [record.decisionId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approved: true, context: { fixture: "latest" }, reasons: ["latest"], decision: { confidence: 0.9 }, trigger: record.trigger, plan });
    expect(rows[0].created_at.getTime()).toBe(record.createdAt);
  });
  it("upserts a trade from open to closed with JSON, PnL and nullable timestamps", async () => {
    const record: PersistedTradeRecord = {
      tradeId: "trade-1", mode: "paper", action: "LONG", side: "BUY", quantity: 0.02,
      remainingQuantity: 0.02, leverage: 2, entryPrice: 100_000, stopLoss: 99_000,
      tp1: 101_000, tp2: 102_000, confidence: 0.8, status: "open", entryReason: "contract",
      entryFee: 1, exitFee: 0, grossPnl: 0, netPnl: -1, mfe: 0, mae: 0,
      openedAt: 1_700_000_000_123, createdAt: 1_700_000_000_123, updatedAt: 1_700_000_000_123,
      details: { stage: "open" }
    };
    await store.saveTrade(record);
    const opened = (await query.query("SELECT * FROM trades WHERE trade_id=$1", [record.tradeId])).rows[0];
    expect(opened.closed_at).toBeNull(); expect(opened.holding_minutes).toBeNull();
    expect(opened.take_profit).toBeNull(); expect(opened.exit_reason).toBeNull();
    await store.saveTrade({ ...record, status: "closed", remainingQuantity: 0, closedAt: record.openedAt + 60_000, holdingMinutes: 1, updatedAt: record.updatedAt + 60_000, grossPnl: 20, netPnl: 18, exitFee: 1, exitReason: "take_profit", details: { stage: "closed", nested: [1, null] } });
    const { rows } = await query.query("SELECT * FROM trades WHERE trade_id=$1", [record.tradeId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "closed", remaining_quantity: 0, entry_price: 100_000, gross_pnl: 20, net_pnl: 18, entry_fee: 1, exit_fee: 1, holding_minutes: 1, exit_reason: "take_profit", details: { stage: "closed", nested: [1, null] } });
    expect(rows[0].opened_at.getTime()).toBe(record.openedAt);
    expect(rows[0].closed_at.getTime()).toBe(record.openedAt + 60_000);
    expect(rows[0].updated_at.getTime()).toBe(record.updatedAt + 60_000);
  });
  it("updates one heartbeat row per service", async () => {
    await store.heartbeat("contract-service", { sequence: 1 });
    await store.heartbeat("contract-service", { sequence: 2, nested: { ok: true } });
    const { rows } = await query.query("SELECT * FROM heartbeats WHERE service_name=$1", ["contract-service"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ sequence: 2, nested: { ok: true } });
    expect(rows[0].updated_at).toBeInstanceOf(Date);
  });
});
