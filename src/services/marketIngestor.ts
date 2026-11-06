import type { Logger } from "pino";
import WebSocket from "ws";

import type { AppConfig } from "../config.js";
import type { AccountState, MarketSnapshot, PositionState } from "../domain/types.js";
import { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";

type MinuteBar = {
  openTime: number;
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
    t: number;
    T: number;
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
  private stopped = false;
  private historyGeneration = 0;
  private historyRepair: Promise<void> | null = null;
  private historyRetryAfter = 0;
  private historyChanged = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly client: BinanceFuturesClient,
    private readonly logger: Logger,
    private readonly callbacks: MarketCallbacks
  ) {}

  public async start(): Promise<void> {
    this.stopped = false;
    this.historyGeneration += 1;
    const filters = await this.client.getSymbolFilters(this.config.symbol);
    this.snapshot = await this.client.composeInitialMarketSnapshot(this.config.symbol, filters);
    const candles = await this.client.getRecentKlines(this.config.symbol, "1m", 240);
    const now = Date.now();
    this.candleHistory = candles.filter((bar) => bar.closeTime < now);
    this.snapshot = this.applyDerivedMetrics(this.snapshot, this.snapshot.markPrice, 0, this.snapshot.markPrice, this.snapshot.markPrice);
    this.lastOpenInterest = this.snapshot.openInterest;
    this.filtersLoaded = true;
    await this.publishMarket(this.snapshot, now);
    await this.refreshSupplemental();
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
    this.historyGeneration += 1;
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
      setTimeout(() => { if (!this.stopped) this.connectMarketSocket(); }, 3_000);
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
    if (!this.snapshot || this.stopped) {
      return;
    }

    const next: MarketSnapshot = { ...this.snapshot };
    const data = payload.data;

    if ("p" in data && "i" in data && "r" in data) {
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
      if (
        !Number.isSafeInteger(data.k.t) || data.k.t <= 0 ||
        !Number.isSafeInteger(data.k.T) || data.k.T < data.k.t
      ) {
        throw new Error("Invalid streaming candle interval");
      }
      const tail = this.candleHistory.at(-1);
      if (tail && data.k.t < tail.openTime) {
        return;
      }
      const close = Number(data.k.c);
      next.lastPrice = close;
      next.volume1m = Number(data.k.v);
      next.timestamp = data.E;
      if (data.k.x) {
        const bar: MinuteBar = {
          openTime: data.k.t,
          close,
          high: Number(data.k.h),
          low: Number(data.k.l),
          volume: Number(data.k.v),
          closeTime: data.k.T
        };
        if (tail?.openTime === bar.openTime) {
          this.candleHistory[this.candleHistory.length - 1] = bar;
        } else {
          this.candleHistory.push(bar);
        }
        this.candleHistory = this.candleHistory.slice(-240);
      }
      this.snapshot = this.applyDerivedMetrics(
        next,
        close,
        Number(data.k.v),
        Number(data.k.h),
        Number(data.k.l)
      );
      await this.publishMarket(this.snapshot, data.E, Number(data.k.h), Number(data.k.l));
      return;
    }

    this.snapshot = next;
    await this.publishMarket(next, data.E);
  }

  private async refreshSupplemental(): Promise<void> {
    if (!this.snapshot || this.stopped) {
      return;
    }

    try {
      const [mark, openInterest, ratio, account, position] = await Promise.all([
        this.client.getMarkPrice(this.config.symbol),
        this.client.getOpenInterest(this.config.symbol),
        this.client.getTopTraderLongShortRatio(this.config.symbol),
        this.config.tradingMode === "live"
          ? this.client.getBalanceState()
          : Promise.resolve(null),
        this.config.tradingMode === "live"
          ? this.client.getPositionState(this.config.symbol)
          : Promise.resolve(null)
      ]);

      const next: MarketSnapshot = {
        ...this.snapshot,
        markPrice: mark.markPrice,
        indexPrice: mark.indexPrice,
        fundingRate: mark.fundingRate,
        nextFundingTime: mark.nextFundingTime,
        openInterest,
        openInterestChangePct1m:
          this.lastOpenInterest > 0 ? ((openInterest - this.lastOpenInterest) / this.lastOpenInterest) * 100 : 0,
        topTraderLongShortRatio: ratio,
        timestamp: Date.now()
      };
      this.snapshot = this.applyDerivedMetrics(
        next,
        next.lastPrice,
        next.volume1m,
        Math.max(next.lastPrice, next.markPrice),
        Math.min(next.lastPrice, next.markPrice)
      );
      this.lastOpenInterest = openInterest;
      await this.publishMarket(this.snapshot, Date.now());
      if (account) {
        await this.callbacks.onAccount(account);
      }
      if (position) {
        await this.callbacks.onPosition(position);
      }
    } catch (error) {
      this.logger.warn({ error, filtersLoaded: this.filtersLoaded }, "Failed to refresh supplemental market data");
    }
  }

  private historyIsReady(at: number): boolean {
    if (!Number.isSafeInteger(at)) return false;
    const currentMinute = Math.floor(at / 60_000) * 60_000;
    const recent = this.candleHistory.filter(bar => bar.closeTime < at).slice(-240);
    if (recent.length === 0 || recent.at(-1)!.openTime !== currentMinute - 60_000) return false;
    return recent.every((bar, index) => index === 0 || bar.openTime - recent[index - 1]!.openTime === 60_000);
  }

  private async publishMarket(snapshot: MarketSnapshot, at: number, high = snapshot.lastPrice, low = snapshot.lastPrice): Promise<void> {
    if (this.stopped) return;
    if (!this.historyIsReady(at)) {
      this.repairHistory();
      return; // Keep quote updates internal until their derived history is contiguous.
    }
    this.snapshot = this.historyChanged
      ? this.applyDerivedMetrics(snapshot, snapshot.lastPrice, snapshot.volume1m, high, low)
      : snapshot;
    this.historyChanged = false;
    await this.callbacks.onMarket(this.snapshot);
  }

  private repairHistory(): void {
    if (this.stopped || this.historyRepair || Date.now() < this.historyRetryAfter) return;
    const generation = this.historyGeneration;
    let expired = false;
    const deadline = setTimeout(() => {
      expired = true;
      this.logger.warn("Market candle recovery exceeded 10 seconds; snapshots remain suppressed");
    }, 10_000);
    const pending = this.client.getRecentKlines(this.config.symbol, "1m", 240).then(rows => {
      if (expired || this.stopped || generation !== this.historyGeneration) return;
      if (!Array.isArray(rows) || rows.length === 0 || rows.length > 240 || rows.some(bar =>
        !Number.isSafeInteger(bar.openTime) || bar.openTime % 60_000 !== 0 ||
        bar.closeTime !== bar.openTime + 59_999 ||
        ![bar.close, bar.high, bar.low, bar.volume].every(Number.isFinite) ||
        bar.low <= 0 || bar.close < bar.low || bar.close > bar.high || bar.volume < 0)) {
        throw new Error("Invalid recovery candle page");
      }
      const completed = rows.filter(bar => bar.closeTime < Date.now());
      // Socket rows can arrive while REST is in flight. Their canonical final values win.
      const merged = new Map(completed.map(bar => [bar.openTime, bar]));
      for (const bar of this.candleHistory) merged.set(bar.openTime, bar);
      const history = [...merged.values()].sort((a, b) => a.openTime - b.openTime).slice(-240);
      const previous = this.candleHistory;
      this.candleHistory = history;
      if (history.length < 60 || !this.historyIsReady(Date.now())) {
        this.candleHistory = previous;
        throw new Error("Recovery candle page is stale or discontinuous");
      }
      this.historyChanged = true;
    }).catch(error => {
      if (!this.stopped && generation === this.historyGeneration) {
        this.logger.warn({ error }, "Failed to recover contiguous market candles");
      }
    }).finally(() => {
      clearTimeout(deadline);
      if (this.historyRepair === pending) this.historyRepair = null;
      this.historyRetryAfter = Date.now() + 3_000;
    });
    // A timed-out request remains single-flight until it actually settles. Never flood REST.
    this.historyRepair = pending;
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
