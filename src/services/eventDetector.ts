import type { EvaluationTrigger, MarketSnapshot, NewsEvent, OnchainSnapshot } from "../domain/types.js";

export class EventDetector {
  private readonly lastTriggered = new Map<string, number>();
  private readonly pendingStartupTriggers = new Map<EvaluationTrigger["reason"], EvaluationTrigger>();
  private startupFlush: Promise<void> | null = null;

  public constructor(
    private readonly onTrigger: (trigger: EvaluationTrigger) => Promise<void> | void,
    private readonly getLatestMarket?: () => MarketSnapshot | null
  ) {}

  public async handleMarket(snapshot: MarketSnapshot): Promise<void> {
    await this.flushStartupTriggers();
    if (Math.abs(snapshot.priceChangePct1m) >= 0.15 || Math.abs(snapshot.priceChangePct5m) >= 0.35) {
      await this.emit({
        reason: "market_breakout",
        priority: 3,
        details: `price momentum 1m=${snapshot.priceChangePct1m.toFixed(2)}% 5m=${snapshot.priceChangePct5m.toFixed(2)}%`,
        triggeredAt: Date.now()
      });
    }

    if (Math.abs(snapshot.openInterestChangePct1m) >= 0.25) {
      await this.emit({
        reason: "open_interest_spike",
        priority: 2,
        details: `open interest delta ${snapshot.openInterestChangePct1m.toFixed(2)}%`,
        triggeredAt: Date.now()
      });
    }

    if (Math.abs(snapshot.fundingRate) >= 0.0002) {
      await this.emit({
        reason: "funding_extreme",
        priority: 1,
        details: `funding rate ${snapshot.fundingRate}`,
        triggeredAt: Date.now()
      });
    }
  }

  public async handleNews(events: NewsEvent[]): Promise<void> {
    const mostRelevant = events.find((event) => event.relevanceScore >= 0.75);
    if (!mostRelevant) {
      return;
    }
    const market = this.getLatestMarket?.() ?? null;
    const priceConfirms =
      market !== null &&
      (Math.abs(market.priceChangePct1m) >= 0.08 || Math.abs(market.priceChangePct5m) >= 0.2);

    await this.emit({
      reason: mostRelevant.tags.includes("macro") ? "macro_relevant" : "news_relevant",
      priority: mostRelevant.relevanceScore >= 0.84 || priceConfirms ? 3 : 2,
      details: `${mostRelevant.source}: ${mostRelevant.title}`,
      triggeredAt: Date.now()
    });
  }

  public async handleOnchain(snapshot: OnchainSnapshot): Promise<void> {
    if (snapshot.fastestFee >= 30 || snapshot.blockCadenceSeconds >= 900) {
      await this.emit({
        reason: "onchain_shift",
        priority: 1,
        details: `mempool fee=${snapshot.fastestFee} cadence=${snapshot.blockCadenceSeconds.toFixed(0)}s`,
        triggeredAt: Date.now()
      });
    }
  }

  public async heartbeat(): Promise<void> {
    await this.emit({
      reason: "minute_recheck",
      priority: 0,
      details: "scheduled one-minute recheck",
      triggeredAt: Date.now()
    });
  }

  private flushStartupTriggers(): Promise<void> {
    if (!this.getLatestMarket?.()) return Promise.resolve();
    if (this.startupFlush) return this.startupFlush;
    const flush = (async () => {
      for (const [reason, trigger] of this.pendingStartupTriggers) {
        await this.emit(trigger);
        if (this.pendingStartupTriggers.get(reason) === trigger) this.pendingStartupTriggers.delete(reason);
      }
    })().finally(() => { if (this.startupFlush === flush) this.startupFlush = null; });
    this.startupFlush = flush;
    return flush;
  }

  private async emit(trigger: EvaluationTrigger): Promise<void> {
    const startupCatalyst = trigger.reason === "news_relevant" || trigger.reason === "macro_relevant" ||
      trigger.reason === "onchain_shift";
    if (startupCatalyst && this.getLatestMarket && !this.getLatestMarket()) {
      // Keep only the newest trigger of each of the three catalyst kinds. A
      // missing first market snapshot must not consume the dispatch cooldown.
      this.pendingStartupTriggers.set(trigger.reason, trigger);
      return;
    }
    const cooldownMs = trigger.reason === "minute_recheck" ? 50_000 : 20_000;
    const previousLast = this.lastTriggered.get(trigger.reason);
    const last = previousLast ?? 0;
    const now = Date.now();
    if (now - last < cooldownMs) {
      return;
    }

    this.lastTriggered.set(trigger.reason, now);

    try {
      await this.onTrigger(trigger);
    } catch (error) {
      if (previousLast === undefined) {
        this.lastTriggered.delete(trigger.reason);
      } else {
        this.lastTriggered.set(trigger.reason, previousLast);
      }
      throw error;
    }
  }
}
