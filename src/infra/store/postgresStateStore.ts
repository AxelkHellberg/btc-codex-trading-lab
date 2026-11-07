import { Pool } from "pg";
import type { Logger } from "pino";

import type { PersistedDecisionRecord, PersistedTradeRecord, TradingMode } from "../../domain/types.js";

export class PostgresStateStore {
  private readonly pool: Pool;

  public constructor(connectionString: string, private readonly logger: Logger) {
    this.pool = new Pool({ connectionString });
  }

  public async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id BIGSERIAL PRIMARY KEY,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        approved BOOLEAN NOT NULL,
        mode TEXT NOT NULL,
        trigger JSONB NOT NULL,
        context JSONB NOT NULL,
        decision JSONB NOT NULL,
        reasons JSONB NOT NULL,
        plan JSONB NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trades (
        trade_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        action TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity DOUBLE PRECISION NOT NULL,
        remaining_quantity DOUBLE PRECISION NULL,
        leverage INTEGER NOT NULL,
        entry_price DOUBLE PRECISION NOT NULL,
        stop_loss DOUBLE PRECISION NULL,
        take_profit DOUBLE PRECISION NULL,
        tp1 DOUBLE PRECISION NULL,
        tp2 DOUBLE PRECISION NULL,
        confidence DOUBLE PRECISION NOT NULL,
        setup_type TEXT NULL,
        status TEXT NOT NULL,
        entry_reason TEXT NULL,
        exit_reason TEXT NULL,
        regime_at_entry TEXT NULL,
        entry_fee DOUBLE PRECISION NULL,
        exit_fee DOUBLE PRECISION NULL,
        gross_pnl DOUBLE PRECISION NULL,
        net_pnl DOUBLE PRECISION NULL,
        mfe DOUBLE PRECISION NULL,
        mae DOUBLE PRECISION NULL,
        opened_at TIMESTAMPTZ NULL,
        closed_at TIMESTAMPTZ NULL,
        holding_minutes DOUBLE PRECISION NULL,
        details JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS heartbeats (
        service_name TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      ALTER TABLE decisions ADD COLUMN IF NOT EXISTS plan JSONB NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS remaining_quantity DOUBLE PRECISION NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS tp1 DOUBLE PRECISION NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS tp2 DOUBLE PRECISION NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS setup_type TEXT NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_reason TEXT NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_reason TEXT NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS regime_at_entry TEXT NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS entry_fee DOUBLE PRECISION NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS exit_fee DOUBLE PRECISION NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS gross_pnl DOUBLE PRECISION NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS net_pnl DOUBLE PRECISION NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS mfe DOUBLE PRECISION NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS mae DOUBLE PRECISION NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS holding_minutes DOUBLE PRECISION NULL;
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      CREATE INDEX IF NOT EXISTS decisions_recent_mode_idx ON decisions (mode, created_at DESC, decision_id DESC);
      CREATE INDEX IF NOT EXISTS trades_recent_mode_idx ON trades (mode, updated_at DESC, trade_id DESC);
    `);
  }

  public async saveSnapshot(kind: string, payload: unknown): Promise<void> {
    await this.pool.query("INSERT INTO snapshots (kind, payload) VALUES ($1, $2::jsonb)", [
      kind,
      JSON.stringify(payload)
    ]);
  }

  public async saveDecision(record: PersistedDecisionRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO decisions (
          decision_id, approved, mode, trigger, context, decision, reasons, plan, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0))
        ON CONFLICT (decision_id) DO UPDATE SET
          approved = EXCLUDED.approved,
          trigger = EXCLUDED.trigger,
          context = EXCLUDED.context,
          decision = EXCLUDED.decision,
          reasons = EXCLUDED.reasons,
          plan = EXCLUDED.plan
      `,
      [
        record.decisionId,
        record.approved,
        record.mode,
        JSON.stringify(record.trigger),
        JSON.stringify(record.context),
        JSON.stringify(record.signal),
        JSON.stringify(record.reasons),
        JSON.stringify(record.plan ?? null),
        record.createdAt
      ]
    );
  }

  public async saveTrade(record: PersistedTradeRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO trades (
          trade_id, mode, action, side, quantity, remaining_quantity, leverage, entry_price, stop_loss,
          take_profit, tp1, tp2, confidence, setup_type, status, entry_reason, exit_reason,
          regime_at_entry, entry_fee, exit_fee, gross_pnl, net_pnl, mfe, mae,
          opened_at, closed_at, holding_minutes, details, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
          $18, $19, $20, $21, $22, $23, $24,
          to_timestamp($25 / 1000.0), to_timestamp($26 / 1000.0), $27, $28,
          to_timestamp($29 / 1000.0), to_timestamp($30 / 1000.0)
        )
        ON CONFLICT (trade_id) DO UPDATE SET
          status = EXCLUDED.status,
          remaining_quantity = EXCLUDED.remaining_quantity,
          details = EXCLUDED.details,
          take_profit = EXCLUDED.take_profit,
          stop_loss = EXCLUDED.stop_loss,
          tp1 = EXCLUDED.tp1,
          tp2 = EXCLUDED.tp2,
          exit_reason = EXCLUDED.exit_reason,
          entry_fee = EXCLUDED.entry_fee,
          exit_fee = EXCLUDED.exit_fee,
          gross_pnl = EXCLUDED.gross_pnl,
          net_pnl = EXCLUDED.net_pnl,
          mfe = EXCLUDED.mfe,
          mae = EXCLUDED.mae,
          closed_at = EXCLUDED.closed_at,
          holding_minutes = EXCLUDED.holding_minutes,
          updated_at = EXCLUDED.updated_at
      `,
      [
        record.tradeId,
        record.mode,
        record.action,
        record.side,
        record.quantity,
        record.remainingQuantity,
        record.leverage,
        record.entryPrice,
        record.stopLoss ?? null,
        record.takeProfit ?? null,
        record.tp1 ?? null,
        record.tp2 ?? null,
        record.confidence,
        record.setupType ?? null,
        record.status,
        record.entryReason,
        record.exitReason ?? null,
        record.regimeAtEntry ?? null,
        record.entryFee,
        record.exitFee,
        record.grossPnl,
        record.netPnl,
        record.mfe,
        record.mae,
        record.openedAt,
        record.closedAt ?? null,
        record.holdingMinutes ?? null,
        JSON.stringify(record.details),
        record.createdAt,
        record.updatedAt
      ]
    );
  }

  public async loadRecentHistory(mode: TradingMode, limit = 25): Promise<{
    decisions: PersistedDecisionRecord[];
    trades: PersistedTradeRecord[];
  }> {
    if ((mode !== "paper" && mode !== "live") || !Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new Error("History requires a trading mode and a limit between 1 and 25");
    }
    // Only persisted audit history is restored. These records never restore
    // broker balances, open positions, orders, or execution authority.
    const [decisions, trades] = await Promise.all([
      this.pool.query<{ record: PersistedDecisionRecord }>(`
        SELECT jsonb_build_object(
          'decisionId', decision_id, 'approved', approved, 'mode', mode,
          'trigger', trigger, 'context', context, 'signal', decision,
          'plan', plan, 'reasons', reasons,
          'createdAt', (EXTRACT(EPOCH FROM created_at) * 1000)::double precision
        ) AS record FROM decisions WHERE mode = $1
        ORDER BY created_at DESC, decision_id DESC LIMIT $2
      `, [mode, limit]),
      this.pool.query<{ record: PersistedTradeRecord }>(`
        SELECT jsonb_build_object(
          'tradeId', trade_id, 'mode', mode, 'action', action, 'side', side,
          'revision', to_jsonb(trades)->'revision',
          'quantity', quantity,
          'remainingQuantity', COALESCE(remaining_quantity, CASE WHEN status = 'closed' THEN 0 ELSE quantity END),
          'leverage', leverage, 'entryPrice', entry_price, 'stopLoss', stop_loss,
          'takeProfit', take_profit, 'tp1', tp1, 'tp2', tp2, 'confidence', confidence,
          'setupType', setup_type, 'status', status, 'entryReason', COALESCE(entry_reason, ''),
          'exitReason', exit_reason, 'regimeAtEntry', regime_at_entry,
          'entryFee', COALESCE(entry_fee, 0), 'exitFee', COALESCE(exit_fee, 0),
          'grossPnl', COALESCE(gross_pnl, 0), 'netPnl', COALESCE(net_pnl, 0),
          'mfe', COALESCE(mfe, 0), 'mae', COALESCE(mae, 0),
          'openedAt', (EXTRACT(EPOCH FROM COALESCE(opened_at, created_at)) * 1000)::double precision,
          'closedAt', (EXTRACT(EPOCH FROM closed_at) * 1000)::double precision,
          'holdingMinutes', holding_minutes, 'details', details,
          'createdAt', (EXTRACT(EPOCH FROM created_at) * 1000)::double precision,
          'updatedAt', (EXTRACT(EPOCH FROM updated_at) * 1000)::double precision
        ) AS record FROM trades WHERE mode = $1
        ORDER BY updated_at DESC, trade_id DESC LIMIT $2
      `, [mode, limit])
    ]);
    // SQL NULL is not the domain's optional-field representation. Do not strip
    // nested JSON nulls (for example context.onchain_snapshot or trade details).
    const omitNullOptionals = <T extends object>(record: T, keys: string[]): T => {
      for (const key of keys) {
        if ((record as Record<string, unknown>)[key] === null) delete (record as Record<string, unknown>)[key];
      }
      return record;
    };
    return {
      decisions: decisions.rows.map(({ record }) => omitNullOptionals(record, ["plan"])),
      trades: trades.rows.map(({ record }) => omitNullOptionals(record, [
        "revision", "stopLoss", "takeProfit", "tp1", "tp2", "setupType", "exitReason", "regimeAtEntry", "closedAt", "holdingMinutes"
      ]))
    };
  }

  public async heartbeat(serviceName: string, payload: unknown): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO heartbeats (service_name, payload, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (service_name) DO UPDATE SET
          payload = EXCLUDED.payload,
          updated_at = NOW()
      `,
      [serviceName, JSON.stringify(payload)]
    );
  }

  public async close(): Promise<void> {
    await this.pool.end().catch((error) => {
      this.logger.warn({ error }, "Failed to close Postgres pool");
    });
  }
}
