import type { Logger } from "pino";

type LockStore = {
  acquireLock(key: string, token: string, ttlMs: number): Promise<boolean>;
  renewLock(key: string, token: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, token: string): Promise<void>;
};

export class DecisionLeaseLostError extends Error {
  public constructor() {
    super("Decision-loop lock ownership could not be confirmed");
    this.name = "DecisionLeaseLostError";
  }
}

/** Keeps one local evaluation active even if its remote lease is lost. */
export class DecisionLease {
  private busy = false;

  public constructor(
    private readonly store: LockStore,
    private readonly logger: Logger,
    private readonly ttlMs = 55_000
  ) {}

  public async run(token: string, work: (assertOwned: () => Promise<void>) => Promise<void>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    let acquired = false;
    let stopped = false;
    let lost = false;
    let timer: NodeJS.Timeout | undefined;
    let pending: Promise<void> | undefined;
    let deadline = performance.now() + this.ttlMs;
    const refreshOnce = async (): Promise<void> => {
      const started = performance.now();
      if (lost || started >= deadline) {
        lost = true;
        return;
      }
      try {
        const owned = await this.store.renewLock("decision-loop", token, this.ttlMs);
        if (!owned || performance.now() >= deadline || performance.now() >= started + this.ttlMs) {
          lost = true;
          return;
        }
        deadline = started + this.ttlMs;
      } catch (error) {
        lost = true;
        this.logger.warn({ error }, "Decision-loop lock renewal failed");
      }
    };
    const refresh = (): Promise<void> => {
      if (!pending) pending = refreshOnce().finally(() => { pending = undefined; });
      return pending;
    };
    const schedule = (): void => {
      if (stopped || lost) return;
      timer = setTimeout(() => {
        void refresh().finally(schedule);
      }, Math.floor(this.ttlMs / 3));
    };
    const assertOwned = async (): Promise<void> => {
      if (!lost) await refresh();
      if (lost) throw new DecisionLeaseLostError();
    };
    try {
      acquired = await this.store.acquireLock("decision-loop", token, this.ttlMs);
      if (!acquired) return false;
      if (performance.now() >= deadline) throw new DecisionLeaseLostError();
      schedule();
      await work(assertOwned);
      if (pending) await pending;
      if (lost || performance.now() >= deadline) throw new DecisionLeaseLostError();
      return true;
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        if (pending) await pending;
        if (acquired) await this.store.releaseLock("decision-loop", token);
      } finally {
        this.busy = false;
      }
    }
  }
}
