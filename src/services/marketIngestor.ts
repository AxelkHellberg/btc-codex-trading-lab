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
  private marketStopped = false;
  private marketGeneration = 0;
  private marketWatchdog: NodeJS.Timeout | null = null;
  private marketReconnectTimer: NodeJS.Timeout | null = null;
  private marketReconnectDelayMs = 3_000;
  private userSocket: WebSocket | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private supplementalStopped = false;
  private supplementalGeneration = 0;
  private supplementalInFlight: Promise<void> | null = null;
  private listenKey: string | null = null;
  private userStreamStopped = false;
  private userStreamGeneration = 0;
  private userStreamStarting: Promise<void> | null = null;
  private userReconnectTimer: NodeJS.Timeout | null = null;
  private userReconnectDelayMs = 3_000;
  private snapshot: MarketSnapshot | null = null;
  private candleHistory: MinuteBar[] = [];
  private lastOpenInterest = 0;
  private filtersLoaded = false;

  public constructor(
    private readonly config: AppConfig,
    private readonly client: BinanceFuturesClient,
    private readonly logger: Logger,
    private readonly callbacks: MarketCallbacks
  ) {}

  public async start(): Promise<void> {
    this.supplementalStopped = false;
    const generation = ++this.supplementalGeneration;
    // A previous session can still own a request; never overlap its network work.
    await this.supplementalInFlight;
    if (!this.isSupplementalCurrent(generation)) return;
    this.marketStopped = false;
    this.userStreamStopped = false;
    const filters = await this.client.getSymbolFilters(this.config.symbol);
    if (!this.isSupplementalCurrent(generation)) return;
    const snapshot = await this.client.composeInitialMarketSnapshot(this.config.symbol, filters);
    if (!this.isSupplementalCurrent(generation)) return;
    const history = await this.client.getRecentKlines(this.config.symbol, "1m", 240);
    if (!this.isSupplementalCurrent(generation)) return;
    this.snapshot = snapshot;
    this.candleHistory = history;
    this.snapshot = this.applyDerivedMetrics(this.snapshot, this.snapshot.markPrice, 0, this.snapshot.markPrice, this.snapshot.markPrice);
    this.lastOpenInterest = this.snapshot.openInterest;
    this.filtersLoaded = true;
    await this.callbacks.onMarket(this.snapshot);
    if (!this.isSupplementalCurrent(generation)) return;
    await this.refreshSupplemental();
    if (!this.isSupplementalCurrent(generation)) return;
    this.connectMarketSocket();
    this.refreshTimer = setInterval(() => {
      void this.refreshSupplemental();
    }, 60_000);

    if (this.config.tradingMode === "live") {
      await this.startUserStream();
    }
  }

  public async stop(): Promise<void> {
    this.supplementalStopped = true;
    this.supplementalGeneration += 1;
    this.marketStopped = true;
    this.marketGeneration += 1;
    this.clearMarketWatchdog();
    if (this.marketReconnectTimer) clearTimeout(this.marketReconnectTimer);
    this.marketReconnectTimer = null;
    const marketSocket = this.marketSocket;
    this.marketSocket = null;
    this.userStreamStopped = true;
    this.userStreamGeneration += 1;
    this.userStreamStarting = null;
    if (this.userReconnectTimer) clearTimeout(this.userReconnectTimer);
    this.userReconnectTimer = null;
    this.client.stopUserStreamKeepalive();
    const userSocket = this.userSocket;
    this.userSocket = null;
    this.listenKey = null;
    marketSocket?.close();
    userSocket?.close();
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
  }

  private connectMarketSocket(): void {
    if (this.marketStopped || this.marketSocket) return;
    const generation = ++this.marketGeneration;
    const url = this.client.getCombinedMarketStreamUrl(this.config.symbol);
    const socket = new WebSocket(url);
    this.marketSocket = socket;
    this.armMarketWatchdog(generation);
    socket.on("message", (raw) => {
      if (this.marketStopped || generation !== this.marketGeneration) return;
      this.marketReconnectDelayMs = 3_000;
      this.armMarketWatchdog(generation);
      void this.handleMarketMessage(raw.toString()).catch((error) => {
        this.logger.warn({ error }, "Failed to process market message");
      });
    });
    socket.on("close", () => this.recoverMarketSocket(generation));
    socket.on("error", () => {
      if (this.marketStopped || generation !== this.marketGeneration) return;
      this.logger.warn("Market websocket transport error");
      this.recoverMarketSocket(generation);
    });
  }

  private clearMarketWatchdog(): void {
    if (this.marketWatchdog) clearTimeout(this.marketWatchdog);
    this.marketWatchdog = null;
  }

  private armMarketWatchdog(generation: number): void {
    this.clearMarketWatchdog();
    // Track stream frames independently of successful supplemental REST polls.
    this.marketWatchdog = setTimeout(() => {
      if (this.marketStopped || generation !== this.marketGeneration) return;
      this.logger.warn("Market websocket silent for 30s; replacing connection");
      this.recoverMarketSocket(generation);
    }, 30_000);
  }

  private recoverMarketSocket(generation: number): void {
    if (this.marketStopped || generation !== this.marketGeneration) return;
    this.marketGeneration += 1;
    this.clearMarketWatchdog();
    const socket = this.marketSocket;
    this.marketSocket = null;
    // Retire handlers before termination, including a synchronous close event.
    socket?.terminate();
    this.scheduleMarketReconnect();
  }

  private scheduleMarketReconnect(): void {
    if (this.marketStopped || this.marketReconnectTimer) return;
    const delay = this.marketReconnectDelayMs;
    this.marketReconnectDelayMs = Math.min(delay * 2, 30_000);
    this.marketReconnectTimer = setTimeout(() => {
      this.marketReconnectTimer = null;
      try { this.connectMarketSocket(); }
      catch {
        this.logger.warn("Market websocket recovery failed; retrying with bounded backoff");
        this.scheduleMarketReconnect();
      }
    }, delay);
  }

  private startUserStream(): Promise<void> {
    if (this.userStreamStopped) return Promise.resolve();
    if (this.userStreamStarting) return this.userStreamStarting;
    const generation = ++this.userStreamGeneration;
    const starting = this.openUserStream(generation).finally(() => {
      if (this.userStreamStarting === starting) this.userStreamStarting = null;
    });
    this.userStreamStarting = starting;
    return starting;
  }

  private async openUserStream(generation: number): Promise<void> {
    const listenKey = await this.client.startUserStream();
    if (this.userStreamStopped || generation !== this.userStreamGeneration) return;
    const socket = this.client.connectUserStream(listenKey, (event) => {
      if (this.userStreamStopped || generation !== this.userStreamGeneration) return;
      if (event && typeof event === "object" && "e" in event && event.e === "listenKeyExpired") {
        this.recoverUserStream(generation);
        return;
      }
      void this.handleUserStreamEvent(event).catch(() => {
        this.logger.warn("Failed to process user stream event");
      });
    });
    this.listenKey = listenKey;
    this.userSocket = socket;
    socket.on("error", (error: unknown) => {
      if (this.userStreamStopped || generation !== this.userStreamGeneration) return;
      // Socket messages can include the private listen-key URL. Log only known codes.
      const suppliedCode = error && typeof error === "object" && "code" in error ? error.code : undefined;
      const code = typeof suppliedCode === "string" &&
        ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE"].includes(suppliedCode)
        ? suppliedCode : "WEBSOCKET_ERROR";
      this.logger.warn({ code }, "User stream websocket transport error");
    });
    socket.on("open", () => {
      if (generation === this.userStreamGeneration) this.userReconnectDelayMs = 3_000;
    });
    socket.on("close", () => this.recoverUserStream(generation));
    this.client.startUserStreamKeepalive(listenKey, () => this.recoverUserStream(generation));
  }

  private recoverUserStream(generation: number): void {
    if (this.userStreamStopped || generation !== this.userStreamGeneration) return;
    this.userStreamGeneration += 1; // Retire every callback belonging to the old stream.
    const socket = this.userSocket;
    this.userSocket = null;
    this.listenKey = null;
    this.client.stopUserStreamKeepalive();
    socket?.close();
    this.logger.warn("User stream unavailable; scheduling listen-key recovery");
    this.scheduleUserReconnect();
  }

  private scheduleUserReconnect(): void {
    if (this.userStreamStopped || this.userReconnectTimer) return;
    const delay = this.userReconnectDelayMs;
    this.userReconnectDelayMs = Math.min(delay * 2, 30_000);
    this.userReconnectTimer = setTimeout(() => {
      this.userReconnectTimer = null;
      const attempt = this.startUserStream();
      const generation = this.userStreamGeneration;
      void attempt.catch(() => {
        if (this.userStreamStopped || generation !== this.userStreamGeneration) return;
        this.logger.warn("User stream recovery failed; retrying with bounded backoff");
        this.scheduleUserReconnect();
      });
    }, delay);
  }

  private async handleUserStreamEvent(event: unknown): Promise<void> {
    const typed = event as { e?: string } | null;
    if (!typed?.e || (typed.e !== "ACCOUNT_UPDATE" && typed.e !== "ORDER_TRADE_UPDATE")) {
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

  private isSupplementalCurrent(generation: number): boolean {
    return !this.supplementalStopped && generation === this.supplementalGeneration;
  }

  private refreshSupplemental(): Promise<void> {
    if (this.supplementalStopped || !this.snapshot) return Promise.resolve();
    if (this.supplementalInFlight) return this.supplementalInFlight;
    const pending = this.pollSupplemental(this.supplementalGeneration).finally(() => {
      if (this.supplementalInFlight === pending) this.supplementalInFlight = null;
    });
    this.supplementalInFlight = pending;
    return pending;
  }

  private async pollSupplemental(generation: number): Promise<void> {
    try {
      const requests = [
        this.client.getMarkPrice(this.config.symbol),
        this.client.getOpenInterest(this.config.symbol),
        this.client.getTopTraderLongShortRatio(this.config.symbol),
        this.config.tradingMode === "live"
          ? this.client.getBalanceState()
          : Promise.resolve(null),
        this.config.tradingMode === "live"
          ? this.client.getPositionState(this.config.symbol)
          : Promise.resolve(null)
      ] as const;
      // One failed request must not free the slot while its siblings still run.
      await Promise.allSettled(requests);
      if (!this.isSupplementalCurrent(generation)) return;
      const [mark, openInterest, ratio, account, position] = await Promise.all(requests);

      if (!this.isSupplementalCurrent(generation) || !this.snapshot) return;
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
      await this.callbacks.onMarket(this.snapshot);
      if (!this.isSupplementalCurrent(generation)) return;
      if (account) {
        await this.callbacks.onAccount(account);
      }
      if (!this.isSupplementalCurrent(generation)) return;
      if (position) {
        await this.callbacks.onPosition(position);
      }
    } catch (error) {
      this.logger.warn({ error, filtersLoaded: this.filtersLoaded }, "Failed to refresh supplemental market data");
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
