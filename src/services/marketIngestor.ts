import type { Logger } from "pino";
import WebSocket from "ws";

import type { AppConfig } from "../config.js";
import type { AccountState, MarketSnapshot, PositionState } from "../domain/types.js";
import { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";

type MinuteBar = {
  close: number;
  high: number;
  low: number;
  volume: number;
  closeTime: number;
};

type MarketCallbacks = {
  onMarket: (snapshot: MarketSnapshot) => Promise<void> | void;
  onAccount: (state: AccountState) => Promise<void> | void;
  onPosition: (state: PositionState) => Promise<void> | void;
};

type MarkPriceEvent = {
  e: "markPriceUpdate";
  p: string;
  i: string;
  r: string;
  T: number;
  E: number;
};

type BookTickerEvent = {
  e: "bookTicker";
  b: string;
  a: string;
  E: number;
};

type KlineEvent = {
  e: "kline";
  E: number;
  k: {
    c: string;
    h: string;
    l: string;
    v: string;
    x: boolean;
  };
};

type CombinedStreamMessage = {
  stream: string;
  data: MarkPriceEvent | BookTickerEvent | KlineEvent;
};

export class MarketIngestor {
  private marketSocket: WebSocket | null = null;
  private userSocket: WebSocket | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private listenKey: string | null = null;
  private snapshot: MarketSnapshot | null = null;
  private candleHistory: MinuteBar[] = [];
  private lastOpenInterest = 0;
  private filtersLoaded = false;
  private markGeneration = 0;
  private supplementalPending: Promise<void> | null = null;
  private supplementalGeneration = 0;
  private stopped = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly client: BinanceFuturesClient,
    private readonly logger: Logger,
    private readonly callbacks: MarketCallbacks
  ) {}

  public async start(): Promise<void> {
    this.stopped = false;
    this.supplementalGeneration += 1;
    this.supplementalPending = null;
    const generation = this.supplementalGeneration;
    const filters = await this.client.getSymbolFilters(this.config.symbol);
    this.snapshot = await this.client.composeInitialMarketSnapshot(this.config.symbol, filters);
    this.candleHistory = await this.client.getRecentKlines(this.config.symbol, "1m", 240);
    this.snapshot = this.applyDerivedMetrics(this.snapshot, this.snapshot.markPrice, 0, this.snapshot.markPrice, this.snapshot.markPrice);
    this.lastOpenInterest = this.snapshot.openInterest;
    this.filtersLoaded = true;
    await this.callbacks.onMarket(this.snapshot);
    await this.refreshSupplemental();
    if (this.stopped || generation !== this.supplementalGeneration) return;
    this.connectMarketSocket();
    this.refreshTimer = setInterval(() => {
      void this.refreshSupplemental();
    }, 60_000);

    if (this.config.tradingMode === "live") {
      await this.startUserStream();
    }
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.supplementalGeneration += 1;
    this.supplementalPending = null;
    this.client.stopUserStreamKeepalive();
    this.marketSocket?.close();
    this.userSocket?.close();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }

  private connectMarketSocket(): void {
    const url = this.client.getCombinedMarketStreamUrl(this.config.symbol);
    this.marketSocket = new WebSocket(url);
    this.marketSocket.on("message", (raw) => {
      void this.handleMarketMessage(raw.toString()).catch((error) => {
        this.logger.warn({ error }, "Failed to process market message");
      });
    });
    this.marketSocket.on("close", () => {
      this.logger.warn("Market websocket closed; reconnecting in 3s");
      setTimeout(() => this.connectMarketSocket(), 3_000);
    });
    this.marketSocket.on("error", (error) => {
      this.logger.warn({ error }, "Market websocket error");
    });
  }

  private async startUserStream(): Promise<void> {
    this.listenKey = await this.client.startUserStream();
    this.client.startUserStreamKeepalive(this.listenKey);
    this.userSocket = this.client.connectUserStream(this.listenKey, (event) => {
      void this.handleUserStreamEvent(event);
    });
    this.userSocket.on("close", () => {
      this.logger.warn("User stream websocket closed; refreshing listenKey");
      setTimeout(() => {
        void this.startUserStream();
      }, 3_000);
    });
  }

  private async handleUserStreamEvent(event: unknown): Promise<void> {
    const typed = event as { e?: string };
    if (!typed.e || (typed.e !== "ACCOUNT_UPDATE" && typed.e !== "ORDER_TRADE_UPDATE")) {
      return;
    }

    const [account, position] = await Promise.all([
      this.client.getBalanceState(),
      this.client.getPositionState(this.config.symbol)
    ]);
    await this.callbacks.onAccount(account);
    await this.callbacks.onPosition(position);
  }

  private async handleMarketMessage(raw: string): Promise<void> {
    const payload = JSON.parse(raw) as CombinedStreamMessage;
    if (!this.snapshot) {
      return;
    }

    const next: MarketSnapshot = { ...this.snapshot };
    const data = payload.data;

    if ("p" in data && "i" in data && "r" in data) {
      this.markGeneration += 1;
      next.markPrice = Number(data.p);
      next.indexPrice = Number(data.i);
      next.lastPrice = Number(data.p);
      next.fundingRate = Number(data.r);
      next.nextFundingTime = Number(data.T);
      next.timestamp = data.E;
    } else if ("b" in data && "a" in data) {
      next.bestBid = Number(data.b);
      next.bestAsk = Number(data.a);
      next.spreadBps =
        next.bestBid > 0 ? ((next.bestAsk - next.bestBid) / next.bestBid) * 10_000 : 0;
      next.timestamp = data.E;
    } else if ("k" in data) {
      const close = Number(data.k.c);
      next.lastPrice = close;
      next.volume1m = Number(data.k.v);
      next.timestamp = data.E;
      if (data.k.x) {
        this.candleHistory.push({
          close,
          high: Number(data.k.h),
          low: Number(data.k.l),
          volume: Number(data.k.v),
          closeTime: data.E
        });
        this.candleHistory = this.candleHistory.slice(-240);
      }
      this.snapshot = this.applyDerivedMetrics(
        next,
        close,
        Number(data.k.v),
        Number(data.k.h),
        Number(data.k.l)
      );
      await this.callbacks.onMarket(this.snapshot);
      return;
    }

    this.snapshot = next;
    await this.callbacks.onMarket(next);
  }

  private refreshSupplemental(): Promise<void> {
    if (!this.snapshot || this.stopped) {
      return Promise.resolve();
    }
    if (this.supplementalPending) {
      return this.supplementalPending;
    }
    const pending = this.readSupplemental(this.supplementalGeneration).finally(() => {
      if (this.supplementalPending === pending) {
        this.supplementalPending = null;
      }
    });
    this.supplementalPending = pending;
    return pending;
  }

  private async readSupplemental(generation: number): Promise<void> {
    // A REST mark may wait behind other public responses. Do not let that
    // buffered result replace a WebSocket mark accepted since this read began.
    const markGeneration = this.markGeneration;
    const current = (): boolean => !this.stopped && generation === this.supplementalGeneration;
    const component = async <T,>(name: string, read: () => Promise<T>, deliver: (value: T) => Promise<void>): Promise<void> => {
      let value: T;
      try {
        value = await read();
      } catch {
        // Signed request failures can contain account data or signatures.
        if (current()) this.logger.warn({ component: name }, "Supplemental upstream read failed");
        return;
      }
      if (current()) await deliver(value);
    };
    const market = component("market", async () => {
      // Wait for every public request even on rejection so a later batch never
      // overlaps leftover requests from a failed public group.
      const [mark, openInterest, ratio] = await Promise.allSettled([
        Promise.resolve().then(() => this.client.getMarkPrice(this.config.symbol)),
        Promise.resolve().then(() => this.client.getOpenInterest(this.config.symbol)),
        Promise.resolve().then(() => this.client.getTopTraderLongShortRatio(this.config.symbol))
      ]);
      if (mark.status === "rejected" || openInterest.status === "rejected" || ratio.status === "rejected") {
        throw new Error("Supplemental market read failed");
      }
      return [mark.value, openInterest.value, ratio.value] as const;
    }, async ([mark, openInterest, ratio]) => {
      const next: MarketSnapshot = {
        ...this.snapshot!,
        ...(markGeneration === this.markGeneration ? {
          markPrice: mark.markPrice,
          indexPrice: mark.indexPrice,
          fundingRate: mark.fundingRate,
          nextFundingTime: mark.nextFundingTime
        } : {}),
        openInterest,
        openInterestChangePct1m:
          this.lastOpenInterest > 0 ? ((openInterest - this.lastOpenInterest) / this.lastOpenInterest) * 100 : 0,
        topTraderLongShortRatio: ratio,
        timestamp: Date.now()
      };
      this.snapshot = this.applyDerivedMetrics(
        next, next.lastPrice, next.volume1m,
        Math.max(next.lastPrice, next.markPrice), Math.min(next.lastPrice, next.markPrice)
      );
      this.lastOpenInterest = openInterest;
      const snapshot = this.snapshot;
      await this.deliverSupplementalCallback("onMarket", () => this.callbacks.onMarket(snapshot));
    });
    const privateReads = this.config.tradingMode === "live" ? [
      component("account", () => this.client.getBalanceState(), async (account) => {
        await this.deliverSupplementalCallback("onAccount", () => this.callbacks.onAccount(account));
      }),
      component("position", () => this.client.getPositionState(this.config.symbol), async (position) => {
        await this.deliverSupplementalCallback("onPosition", () => this.callbacks.onPosition(position));
      })
    ] : [];
    // Each component publishes when ready; a stalled or rejected peer cannot
    // discard usable results. The batch remains single-flight until all settle.
    await Promise.all([market, ...privateReads]);
  }

  private async deliverSupplementalCallback(
    callback: keyof MarketCallbacks,
    deliver: () => Promise<void> | void
  ): Promise<void> {
    try {
      await deliver();
    } catch {
      this.logger.warn({ callback }, "Supplemental market callback failed");
    }
  }

  private applyDerivedMetrics(
    snapshot: MarketSnapshot,
    currentClose: number,
    currentVolume: number,
    currentHigh: number,
    currentLow: number
  ): MarketSnapshot {
    const closes = this.candleHistory.map((bar) => bar.close);
    const highs = this.candleHistory.map((bar) => bar.high);
    const lows = this.candleHistory.map((bar) => bar.low);
    const volumes = this.candleHistory.map((bar) => bar.volume);

    const ref = (lookback: number): number => {
      const index = Math.max(0, closes.length - lookback);
      return closes[index] ?? currentClose;
    };

    const changePct = (reference: number): number =>
      reference > 0 ? ((currentClose - reference) / reference) * 100 : 0;

    const ema = (series: number[], period: number): number => {
      if (series.length === 0) {
        return currentClose;
      }
      const k = 2 / (period + 1);
      let value = series[0]!;
      for (const item of series.slice(1)) {
        value = item * k + value * (1 - k);
      }
      return value;
    };

    const average = (series: number[]): number =>
      series.length === 0 ? 0 : series.reduce((sum, value) => sum + value, 0) / series.length;

    const intradayHigh = Math.max(currentHigh, ...(highs.length > 0 ? highs : [currentClose]));
    const intradayLow = Math.min(currentLow, ...(lows.length > 0 ? lows : [currentClose]));
    const emaFast = ema([...closes.slice(-8), currentClose], 9);
    const emaMedium = ema([...closes.slice(-20), currentClose], 21);
    const recentAverageVolume = average(volumes.slice(-20));
    const volumeAcceleration = recentAverageVolume > 0 ? currentVolume / recentAverageVolume : 1;

    return {
      ...snapshot,
      priceChangePct1m: changePct(ref(1)),
      priceChangePct5m: changePct(ref(5)),
      priceChangePct15m: changePct(ref(15)),
      priceChangePct1h: changePct(ref(60)),
      intradayHigh,
      intradayLow,
      distanceFromIntradayHighPct:
        intradayHigh > 0 ? ((intradayHigh - currentClose) / intradayHigh) * 100 : 0,
      distanceFromIntradayLowPct:
        intradayLow > 0 ? ((currentClose - intradayLow) / intradayLow) * 100 : 0,
      emaFast,
      emaMedium,
      trendStrengthPct: currentClose > 0 ? ((emaFast - emaMedium) / currentClose) * 100 : 0,
      volumeAcceleration
    };
  }
}
