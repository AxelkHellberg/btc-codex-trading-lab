import type { EvaluationTrigger, MarketSnapshot, NewsEvent, OnchainSnapshot } from "../domain/types.js";

export class EventDetector {
  private readonly lastTriggered = new Map<string, number>();

  public constructor(
    private readonly onTrigger: (trigger: EvaluationTrigger) => Promise<void> | void,
    private readonly getLatestMarket?: () => MarketSnapshot | null
  ) {}

  public async handleMarket(snapshot: MarketSnapshot): Promise<void> {
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

  private async emit(trigger: EvaluationTrigger): Promise<void> {
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
