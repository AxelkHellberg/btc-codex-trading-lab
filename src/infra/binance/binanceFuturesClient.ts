import crypto from "node:crypto";

import type { Logger } from "pino";
import WebSocket from "ws";

import type {
  AccountState,
  MarketSnapshot,
  PositionState,
  SymbolFilters
} from "../../domain/types.js";
import { fetchJson, HttpError } from "../../lib/http.js";

type BalanceResponse = Array<{
  asset: string;
  balance: string;
  availableBalance: string;
  crossWalletBalance: string;
  crossUnPnl: string;
  updateTime: number;
}>;

type PositionRiskResponse = Array<{
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unRealizedProfit: string;
  liquidationPrice: string;
  leverage?: string;
  updateTime: number;
}>;

type ExchangeInformationResponse = {
  symbols: Array<{
    symbol: string;
    filters: Array<Record<string, string>>;
  }>;
};

type KlineResponse = Array<
  [
    number,
    string,
    string,
    string,
    string,
    string,
    number,
    string,
    number,
    string,
    string,
    string
  ]
>;

export class BinanceFuturesClient {
  private userStreamKeepaliveTimer: NodeJS.Timeout | null = null;

  public constructor(
    private readonly baseUrl: string,
    private readonly wsBaseUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly logger: Logger
  ) {}

  public getCombinedMarketStreamUrl(symbol: string): string {
    const streamSymbol = symbol.toLowerCase();
    const streams = [
      `${streamSymbol}@markPrice@1s`,
      `${streamSymbol}@bookTicker`,
      `${streamSymbol}@kline_1m`
    ].join("/");
    return `${this.wsBaseUrl}?streams=${streams}`;
  }

  public async getSymbolFilters(symbol: string): Promise<SymbolFilters | undefined> {
    const response = await this.publicGet<ExchangeInformationResponse>("/fapi/v1/exchangeInfo");
    const found = response.symbols.find((entry) => entry.symbol === symbol);

    if (!found) {
      return undefined;
    }

    const priceFilter = found.filters.find((filter) => filter.filterType === "PRICE_FILTER");
    const lotSize = found.filters.find((filter) => filter.filterType === "LOT_SIZE");
    const minNotional = found.filters.find((filter) => filter.filterType === "MIN_NOTIONAL");

    return {
      tickSize: Number(priceFilter?.tickSize ?? "0.1"),
      stepSize: Number(lotSize?.stepSize ?? "0.001"),
      minQty: Number(lotSize?.minQty ?? "0.001"),
      minNotional: minNotional ? Number(minNotional.notional ?? "0") : undefined
    };
  }

  public async getOpenInterest(symbol: string): Promise<number> {
    const response = await this.publicGet<{ openInterest: string }>("/fapi/v1/openInterest", { symbol });
    return Number(response.openInterest);
  }

  public async getTopTraderLongShortRatio(symbol: string): Promise<number> {
    const response = await this.publicGet<
      Array<{
        longShortRatio: string;
      }>
    >("/futures/data/topLongShortPositionRatio", {
      symbol,
      period: "5m",
      limit: "1"
    });
    return Number(response[0]?.longShortRatio ?? 1);
  }

  public async getMarkPrice(symbol: string): Promise<{
    markPrice: number;
    indexPrice: number;
    fundingRate: number;
    nextFundingTime: number;
  }> {
    const response = await this.publicGet<{
      markPrice: string;
      indexPrice: string;
      lastFundingRate: string;
      nextFundingTime: number;
    }>("/fapi/v1/premiumIndex", { symbol });

    return {
      markPrice: Number(response.markPrice),
      indexPrice: Number(response.indexPrice),
      fundingRate: Number(response.lastFundingRate),
      nextFundingTime: Number(response.nextFundingTime)
    };
  }

  public async getRecentKlines(
    symbol: string,
    interval: string,
    limit: number
  ): Promise<
    Array<{
      openTime: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      closeTime: number;
    }>
  > {
    const response = await this.publicGet<KlineResponse>("/fapi/v1/klines", {
      symbol,
      interval,
      limit
    });

    return response.map((row) => ({
      openTime: row[0],
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5]),
      closeTime: row[6]
    }));
  }

  public async getBalanceState(): Promise<AccountState> {
    const balances = await this.signedGet<BalanceResponse>("/fapi/v3/balance");
    const usdt = balances.find((entry) => entry.asset === "USDT");
    const equity =
      Number(usdt?.crossWalletBalance ?? 0) + Number(usdt?.crossUnPnl ?? 0) || Number(usdt?.balance ?? 0);

    return {
      equity,
      walletBalance: Number(usdt?.balance ?? 0),
      availableBalance: Number(usdt?.availableBalance ?? 0),
      dailyPnl: 0,
      weeklyDrawdown: 0,
      consecutiveLosses: 0,
      openOrders: 0,
      updatedAt: Number(usdt?.updateTime ?? Date.now())
    };
  }

  public async getPositionState(symbol: string): Promise<PositionState> {
    const positions = await this.signedGet<PositionRiskResponse>("/fapi/v3/positionRisk", { symbol });
    const position = positions.find((entry) => entry.symbol === symbol && Number(entry.positionAmt) !== 0);

    if (!position) {
      return {
        side: "flat",
        quantity: 0,
        entryPrice: 0,
        markPrice: 0,
        leverage: 1,
        unrealizedPnl: 0,
        realizedPnl: 0
      };
    }

    const quantity = Math.abs(Number(position.positionAmt));
    return {
      side: Number(position.positionAmt) > 0 ? "long" : "short",
      quantity,
      entryPrice: Number(position.entryPrice),
      markPrice: Number(position.markPrice),
      leverage: Number(position.leverage ?? 1),
      unrealizedPnl: Number(position.unRealizedProfit),
      realizedPnl: 0,
      openedAt: Number(position.updateTime),
      sourceTradeId: undefined
    };
  }

  public async changeLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signedPost("/fapi/v1/leverage", {
      symbol,
      leverage: String(leverage)
    });
  }

  public async createOrder(params: Record<string, string | number | boolean>): Promise<unknown> {
    return this.signedPost("/fapi/v1/order", params);
  }

  public async cancelAllOrders(symbol: string): Promise<unknown> {
    return this.signedDelete("/fapi/v1/allOpenOrders", { symbol });
  }

  public async startUserStream(): Promise<string> {
    const response = await this.unsignedPrivatePost<{ listenKey: string }>("/fapi/v1/listenKey");
    return response.listenKey;
  }

  public startUserStreamKeepalive(listenKey: string): void {
    this.stopUserStreamKeepalive();
    this.userStreamKeepaliveTimer = setInterval(() => {
      void this.unsignedPrivatePut("/fapi/v1/listenKey", { listenKey }).catch((error) => {
        this.logger.warn({ error }, "Failed to keepalive Binance listenKey");
      });
    }, 50 * 60_000);
  }

  public stopUserStreamKeepalive(): void {
    if (this.userStreamKeepaliveTimer) {
      clearInterval(this.userStreamKeepaliveTimer);
      this.userStreamKeepaliveTimer = null;
    }
  }

  public connectUserStream(listenKey: string, onMessage: (event: unknown) => void): WebSocket {
    const socket = new WebSocket(this.getUserStreamUrl(listenKey));
    socket.on("message", (payload) => {
      try {
        onMessage(JSON.parse(payload.toString()) as unknown);
      } catch (error) {
        this.logger.warn({ error }, "Failed to parse user stream event");
      }
    });
    return socket;
  }

  private getUserStreamUrl(listenKey: string): string {
    const url = new URL(this.wsBaseUrl);
    const basePath = url.pathname.replace(/\/stream\/?$/, "");
    url.pathname = `${basePath}/ws/${listenKey}`.replace(/\/{2,}/g, "/");
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  public async composeInitialMarketSnapshot(symbol: string, filters?: SymbolFilters): Promise<MarketSnapshot> {
    const [mark, openInterest, ratio] = await Promise.all([
      this.getMarkPrice(symbol),
      this.getOpenInterest(symbol),
      this.getTopTraderLongShortRatio(symbol)
    ]);

    return {
      symbol,
      markPrice: mark.markPrice,
      indexPrice: mark.indexPrice,
      lastPrice: mark.markPrice,
      bestBid: mark.markPrice,
      bestAsk: mark.markPrice,
      spreadBps: 0,
      fundingRate: mark.fundingRate,
      nextFundingTime: mark.nextFundingTime,
      openInterest,
      openInterestChangePct1m: 0,
      topTraderLongShortRatio: ratio,
      volume1m: 0,
      priceChangePct1m: 0,
      priceChangePct5m: 0,
      priceChangePct15m: 0,
      priceChangePct1h: 0,
      intradayHigh: mark.markPrice,
      intradayLow: mark.markPrice,
      distanceFromIntradayHighPct: 0,
      distanceFromIntradayLowPct: 0,
      emaFast: mark.markPrice,
      emaMedium: mark.markPrice,
      trendStrengthPct: 0,
      volumeAcceleration: 0,
      timestamp: Date.now(),
      filters
    };
  }

  private sign(query: URLSearchParams): string {
    return crypto.createHmac("sha256", this.apiSecret).update(query.toString()).digest("hex");
  }

  private async publicGet<T>(
    path: string,
    params?: Record<string, string | number | boolean>
  ): Promise<T> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      query.set(key, String(value));
    }
    const queryString = query.toString();
    return fetchJson<T>(`${this.baseUrl}${path}${queryString ? `?${queryString}` : ""}`);
  }

  private async signedGet<T>(path: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const query = new URLSearchParams();
    query.set("timestamp", String(Date.now()));
    for (const [key, value] of Object.entries(params ?? {})) {
      query.set(key, String(value));
    }
    query.set("signature", this.sign(query));
    return fetchJson<T>(`${this.baseUrl}${path}?${query.toString()}`, {
      headers: {
        "X-MBX-APIKEY": this.apiKey
      }
    });
  }

  private async signedPost(path: string, params?: Record<string, string | number | boolean>): Promise<unknown> {
    const body = new URLSearchParams();
    body.set("timestamp", String(Date.now()));
    for (const [key, value] of Object.entries(params ?? {})) {
      body.set(key, String(value));
    }
    body.set("signature", this.sign(body));
    return fetchJson(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-MBX-APIKEY": this.apiKey
      },
      body
    });
  }

  private async signedDelete(path: string, params?: Record<string, string | number | boolean>): Promise<unknown> {
    const body = new URLSearchParams();
    body.set("timestamp", String(Date.now()));
    for (const [key, value] of Object.entries(params ?? {})) {
      body.set(key, String(value));
    }
    body.set("signature", this.sign(body));
    return fetchJson(`${this.baseUrl}${path}?${body.toString()}`, {
      method: "DELETE",
      headers: {
        "X-MBX-APIKEY": this.apiKey
      }
    });
  }

  private async unsignedPrivatePost<T>(path: string): Promise<T> {
    return fetchJson<T>(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "X-MBX-APIKEY": this.apiKey
      }
    });
  }

  private async unsignedPrivatePut<T>(
    path: string,
    params: Record<string, string | number | boolean>
  ): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      body.set(key, String(value));
    }
    return fetchJson<T>(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "X-MBX-APIKEY": this.apiKey
      },
      body
    });
  }
}
