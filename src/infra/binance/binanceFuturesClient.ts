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

const marketObject = (value: unknown, endpoint: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Binance ${endpoint} response`);
  }
  return value as Record<string, unknown>;
};

const marketDecimal = (value: unknown, endpoint: string, field: string, minimum?: number): number => {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Number(value))) {
    throw new Error(`Invalid Binance ${endpoint} field: ${field}`);
  }
  const number = Number(value);
  if (minimum !== undefined && number < minimum) {
    throw new Error(`Invalid Binance ${endpoint} field: ${field}`);
  }
  return number;
};

const positiveMarketDecimal = (value: unknown, endpoint: string, field: string): number => {
  const number = marketDecimal(value, endpoint, field, 0);
  if (number === 0) {
    throw new Error(`Invalid Binance ${endpoint} field: ${field}`);
  }
  return number;
};

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
    const response = marketObject(await this.publicGet<unknown>("/fapi/v1/openInterest", { symbol }), "openInterest");
    return marketDecimal(response.openInterest, "openInterest", "openInterest", 0);
  }

  public async getTopTraderLongShortRatio(symbol: string): Promise<number> {
    const response = await this.publicGet<unknown>("/futures/data/topLongShortPositionRatio", {
      symbol,
      period: "5m",
      limit: "1"
    });
    if (!Array.isArray(response) || response.length === 0) {
      throw new Error("Invalid Binance topTraderLongShortRatio response: missing observation");
    }
    const row = marketObject(response[0], "topTraderLongShortRatio");
    return positiveMarketDecimal(row.longShortRatio, "topTraderLongShortRatio", "longShortRatio");
  }

  public async getMarkPrice(symbol: string): Promise<{
    markPrice: number;
    indexPrice: number;
    fundingRate: number;
    nextFundingTime: number;
  }> {
    const response = marketObject(await this.publicGet<unknown>("/fapi/v1/premiumIndex", { symbol }), "premiumIndex");
    const nextFundingTime = response.nextFundingTime;
    if (typeof nextFundingTime !== "number" || !Number.isSafeInteger(nextFundingTime) || nextFundingTime < 0) {
      throw new Error("Invalid Binance premiumIndex field: nextFundingTime");
    }

    return {
      markPrice: positiveMarketDecimal(response.markPrice, "premiumIndex", "markPrice"),
      indexPrice: positiveMarketDecimal(response.indexPrice, "premiumIndex", "indexPrice"),
      fundingRate: marketDecimal(response.lastFundingRate, "premiumIndex", "lastFundingRate"),
      nextFundingTime
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
    const response = await this.publicGet<unknown>("/fapi/v1/klines", {
      symbol,
      interval,
      limit
    });

    if (!Array.isArray(response)) {
      throw new Error("Invalid Binance klines response");
    }
    let previousOpenTime = -1;
    return response.map((row: unknown) => {
      if (!Array.isArray(row) || row.length < 7) {
        throw new Error("Invalid Binance klines row");
      }
      const [openTime, , , , , , closeTime] = row;
      if (typeof openTime !== "number" || !Number.isSafeInteger(openTime) || openTime < 0 ||
        typeof closeTime !== "number" || !Number.isSafeInteger(closeTime) || closeTime < openTime ||
        openTime <= previousOpenTime) {
        throw new Error("Invalid Binance klines timestamps or ordering");
      }
      const open = positiveMarketDecimal(row[1], "klines", "open");
      const high = positiveMarketDecimal(row[2], "klines", "high");
      const low = positiveMarketDecimal(row[3], "klines", "low");
      const close = positiveMarketDecimal(row[4], "klines", "close");
      const volume = marketDecimal(row[5], "klines", "volume", 0);
      if (low > Math.min(open, close) || high < Math.max(open, close) || low > high) {
        throw new Error("Invalid Binance klines OHLC range");
      }
      previousOpenTime = openTime;
      return { openTime, high, low, close, volume, closeTime };
    });
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
    const socket = new WebSocket(`wss://fstream.binance.com/ws/${listenKey}`);
    socket.on("message", (payload) => {
      try {
        onMessage(JSON.parse(payload.toString()) as unknown);
      } catch (error) {
        this.logger.warn({ error }, "Failed to parse user stream event");
      }
    });
    return socket;
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
