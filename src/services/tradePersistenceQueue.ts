import type { Logger } from "pino";
import type { PersistedTradeRecord } from "../domain/types.js";

type Pending = { record: PersistedTradeRecord; failures: number; retryAt: number; error?: unknown };
export interface TradePersistenceStatus {
  pending: number;
  retrying: boolean;
  oldestPendingAt: number | null;
}

/** In-memory audit repair only. Never invokes a broker or notifier. */
export class TradePersistenceQueue {
  private readonly pending = new Map<string, Pending & { queuedAt: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopping = false;

  public constructor(
    private readonly write: (record: PersistedTradeRecord) => Promise<void>,
    private readonly logger: Logger
  ) {}

  public status(): TradePersistenceStatus {
    return {
      pending: this.pending.size,
      retrying: this.inFlight !== undefined,
      oldestPendingAt: this.pending.size ? [...this.pending.values()].reduce((oldest, entry) => Math.min(oldest, entry.queuedAt), Infinity) : null
    };
  }

  public async save(record: PersistedTradeRecord): Promise<void> {
    if (this.stopping) throw new Error("Trade persistence queue is stopping");
    if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error("Trade revision must be positive");
    const current = this.pending.get(record.tradeId);
    // Coalesce pending revisions; a delayed partial must never replace a close.
    if (!current || record.revision > current.record.revision) {
      this.pending.set(record.tradeId, {
        record: structuredClone(record), failures: 0, retryAt: Date.now(), queuedAt: current?.queuedAt ?? Date.now()
      });
    }
    await this.flush();
    const remaining = this.pending.get(record.tradeId);
    if (remaining) throw remaining.error ?? new Error("Trade persistence pending retry");
  }

  private flush(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      // A finite snapshot prevents a hot producer from starving shutdown or retry backoff.
      for (const [id, entry] of [...this.pending]) {
        if (!force && entry.retryAt > Date.now()) continue;
        // A newer queued revision may have replaced this snapshot entry.
        if (this.pending.get(id) !== entry) continue;
        try {
          await this.write(entry.record);
          if (this.pending.get(id) === entry) {
            this.pending.delete(id);
            if (entry.failures) this.logger.info({ tradeId: id, revision: entry.record.revision }, "Trade persistence recovered");
          }
        } catch (error) {
          if (this.pending.get(id) === entry) {
            entry.failures += 1;
            entry.error = error;
            const delay = Math.min(30_000, 1000 * 2 ** Math.min(entry.failures - 1, 5));
            entry.retryAt = Date.now() + delay;
            this.logger.warn({ tradeId: id, revision: entry.record.revision, failures: entry.failures, retryInMs: delay }, "Trade persistence pending retry");
          }
        }
      }
    })().finally(() => {
      this.inFlight = undefined;
      this.schedule();
    });
    return this.inFlight;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.stopping || !this.pending.size) return;
    const next = [...this.pending.values()].reduce((soonest, entry) => Math.min(soonest, entry.retryAt), Infinity);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, Math.max(1, next - Date.now()));
    this.timer.unref();
  }

  /** Producers and accepted runtime work must be drained before calling stop. */
  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
    await this.flush(true);
    if (this.pending.size) {
      this.logger.error({ pending: this.pending.size }, "Unpersisted trades remain at shutdown; in-memory retries will be lost on exit");
      throw new Error(`${this.pending.size} trade records remain unpersisted`);
    }
  }
}
