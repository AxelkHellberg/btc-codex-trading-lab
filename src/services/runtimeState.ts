import type {
  AccountState,
  DecisionContext,
  EvaluationTrigger,
  MarketRegime,
  MarketSnapshot,
  NewsEvent,
  OnchainSnapshot,
  PersistedDecisionRecord,
  PersistedTradeRecord,
  PositionState,
  RiskState
} from "../domain/types.js";

export class RuntimeState {
  private latestMarket: MarketSnapshot | null = null;
  private latestOnchain: OnchainSnapshot | null = null;
  private news: NewsEvent[] = [];
  private account: AccountState;
  private position: PositionState;
  private decisions: PersistedDecisionRecord[] = [];
  private trades: PersistedTradeRecord[] = [];

  public constructor(initialEquity: number) {
    const now = Date.now();
    this.account = {
      equity: initialEquity,
      walletBalance: initialEquity,
      availableBalance: initialEquity,
      dailyPnl: 0,
      weeklyDrawdown: 0,
      consecutiveLosses: 0,
      openOrders: 0,
      updatedAt: now
    };
    this.position = {
      side: "flat",
      quantity: 0,
      entryPrice: 0,
      markPrice: 0,
      leverage: 1,
      unrealizedPnl: 0,
      realizedPnl: 0
    };
  }

  public setMarket(snapshot: MarketSnapshot): void {
    this.latestMarket = snapshot;
    if (this.position.side !== "flat" && this.position.quantity > 0) {
      const direction = this.position.side === "long" ? 1 : -1;
      this.position = {
        ...this.position,
        markPrice: snapshot.markPrice,
        unrealizedPnl:
          (snapshot.markPrice - this.position.entryPrice) * this.position.quantity * direction
      };
    }
  }

  public setOnchain(snapshot: OnchainSnapshot): void {
    this.latestOnchain = snapshot;
  }

  public pushNews(events: NewsEvent[]): void {
    const dedupe = new Map(this.news.map((event) => [event.id, event] as const));
    for (const event of events) {
      dedupe.set(event.id, event);
    }

    this.news = [...dedupe.values()]
      .sort((left, right) => right.publishedAt - left.publishedAt)
      .slice(0, 25);
  }

  public setAccount(account: AccountState): void {
    this.account = account;
  }

  public setPosition(position: PositionState): void {
    this.position = position;
  }

  public getMarket(): MarketSnapshot | null {
    return this.latestMarket;
  }

  public getOnchain(): OnchainSnapshot | null {
    return this.latestOnchain;
  }

  public getNews(): NewsEvent[] {
    return [...this.news];
  }

  public getAccount(): AccountState {
    return { ...this.account };
  }

  public getPosition(): PositionState {
    return { ...this.position };
  }

  public getRiskState(policy: {
    maxDailyLoss: number;
    maxWeeklyDrawdown: number;
    cooldownMinutes: number;
  }): RiskState {
    const reasons: string[] = [];
    const dailyLossHit = this.account.dailyPnl <= -policy.maxDailyLoss * this.account.walletBalance;
    const weeklyDrawdownHit = this.account.weeklyDrawdown >= policy.maxWeeklyDrawdown;
    const cooldownActive =
      this.account.consecutiveLosses >= 2 &&
      this.account.lastLossAt !== undefined &&
      Date.now() - this.account.lastLossAt < policy.cooldownMinutes * 60_000;

    if (dailyLossHit) {
      reasons.push("daily loss limit reached");
    }

    if (weeklyDrawdownHit) {
      reasons.push("weekly drawdown limit reached");
    }

    if (cooldownActive) {
      reasons.push("loss cooldown active");
    }

    return {
      withinDailyLossLimit: !dailyLossHit,
      withinWeeklyDrawdown: !weeklyDrawdownHit,
      cooldownActive,
      reasons
    };
  }

  public buildDecisionContext(
    trigger: EvaluationTrigger,
    policy: {
      maxDailyLoss: number;
      maxWeeklyDrawdown: number;
      cooldownMinutes: number;
    }
  ): DecisionContext | null {
    if (!this.latestMarket) {
      return null;
    }

    const latestNews = this.news.slice(0, 10);
    const weightedSentiment = latestNews.reduce(
      (accumulator, event) => accumulator + event.sentimentScore * event.relevanceScore,
      0
    );
    const totalWeight = latestNews.reduce((accumulator, event) => accumulator + event.relevanceScore, 0);
    const averageSentiment = totalWeight > 0 ? weightedSentiment / totalWeight : 0;
    const momentumScore =
      this.latestMarket.priceChangePct1m * 0.35 +
      this.latestMarket.priceChangePct5m * 0.3 +
      this.latestMarket.priceChangePct15m * 0.2 +
      this.latestMarket.trendStrengthPct * 0.15;

    const trendBias =
      this.latestMarket.emaFast > this.latestMarket.emaMedium && this.latestMarket.priceChangePct15m >= 0
        ? "bullish"
        : this.latestMarket.emaFast < this.latestMarket.emaMedium && this.latestMarket.priceChangePct15m <= 0
          ? "bearish"
          : "neutral";
    const catalystBias = averageSentiment > 0.12 ? "bullish" : averageSentiment < -0.12 ? "bearish" : "neutral";
    const notes = [
      `volume acceleration ${this.latestMarket.volumeAcceleration.toFixed(2)}x versus recent average`,
      `distance to intraday high ${this.latestMarket.distanceFromIntradayHighPct.toFixed(2)}%`,
      `distance to intraday low ${this.latestMarket.distanceFromIntradayLowPct.toFixed(2)}%`
    ];

    const regime = this.classifyRegime(this.latestMarket);

    return {
      market_snapshot: this.latestMarket,
      derivatives_snapshot: {
        funding_rate: this.latestMarket.fundingRate,
        next_funding_time: this.latestMarket.nextFundingTime,
        open_interest: this.latestMarket.openInterest,
        open_interest_change_pct_1m: this.latestMarket.openInterestChangePct1m,
        top_trader_long_short_ratio: this.latestMarket.topTraderLongShortRatio
      },
      news_events: this.news.slice(0, 10),
      onchain_snapshot: this.latestOnchain,
      position_state: this.getPosition(),
      account_state: this.getAccount(),
      risk_state: this.getRiskState(policy),
      context_summary: {
        regime,
        trend_bias: trendBias,
        catalyst_bias: catalystBias,
        momentum_score: Number(momentumScore.toFixed(3)),
        key_levels: {
          intraday_high: this.latestMarket.intradayHigh,
          intraday_low: this.latestMarket.intradayLow
        },
        notes
      },
      trigger
    };
  }

  public pushDecision(record: PersistedDecisionRecord): void {
    this.decisions = [record, ...this.decisions].slice(0, 25);
  }

  public upsertTrade(record: PersistedTradeRecord): void {
    this.trades = [record, ...this.trades.filter((trade) => trade.tradeId !== record.tradeId)].slice(0, 25);
  }

  public getRecentDecisions(): PersistedDecisionRecord[] {
    return [...this.decisions];
  }

  public getRecentTrades(): PersistedTradeRecord[] {
    return [...this.trades];
  }

  public getTradeStats(): {
    realizedPnl: number;
    unrealizedPnl: number;
    winRate: number;
    expectancy: number;
    profitFactor: number;
    averageWinner: number;
    averageLoser: number;
    averageMfe: number;
    averageMae: number;
    exitDistribution: Record<string, number>;
  } {
    const closedTrades = this.trades.filter((trade) => trade.status === "closed");
    const winners = closedTrades.filter((trade) => trade.netPnl > 0);
    const losers = closedTrades.filter((trade) => trade.netPnl < 0);
    const grossProfit = winners.reduce((sum, trade) => sum + trade.netPnl, 0);
    const grossLoss = Math.abs(losers.reduce((sum, trade) => sum + trade.netPnl, 0));
    const exitDistribution = closedTrades.reduce<Record<string, number>>((accumulator, trade) => {
      const reason = trade.exitReason ?? "unknown";
      accumulator[reason] = (accumulator[reason] ?? 0) + 1;
      return accumulator;
    }, {});

    return {
      realizedPnl: closedTrades.reduce((sum, trade) => sum + trade.netPnl, 0),
      unrealizedPnl: this.position.unrealizedPnl,
      winRate: closedTrades.length > 0 ? winners.length / closedTrades.length : 0,
      expectancy: closedTrades.length > 0 ? closedTrades.reduce((sum, trade) => sum + trade.netPnl, 0) / closedTrades.length : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0,
      averageWinner: winners.length > 0 ? grossProfit / winners.length : 0,
      averageLoser: losers.length > 0 ? losers.reduce((sum, trade) => sum + trade.netPnl, 0) / losers.length : 0,
      averageMfe: closedTrades.length > 0 ? closedTrades.reduce((sum, trade) => sum + trade.mfe, 0) / closedTrades.length : 0,
      averageMae: closedTrades.length > 0 ? closedTrades.reduce((sum, trade) => sum + trade.mae, 0) / closedTrades.length : 0,
      exitDistribution
    };
  }

  private classifyRegime(snapshot: MarketSnapshot): MarketRegime {
    if (
      snapshot.emaFast > snapshot.emaMedium &&
      snapshot.priceChangePct15m >= 0.2 &&
      snapshot.priceChangePct1h >= 0.6 &&
      snapshot.trendStrengthPct >= 0.18
    ) {
      return "trend_up";
    }

    if (
      snapshot.emaFast < snapshot.emaMedium &&
      snapshot.priceChangePct15m <= -0.2 &&
      snapshot.priceChangePct1h <= -0.6 &&
      snapshot.trendStrengthPct <= -0.18
    ) {
      return "trend_down";
    }

    if (Math.abs(snapshot.priceChangePct5m) < 0.18 && Math.abs(snapshot.trendStrengthPct) < 0.14) {
      return "range";
    }

    return "transition";
  }
}
