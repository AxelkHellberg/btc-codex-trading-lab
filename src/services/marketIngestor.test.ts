import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import type { AccountState, MarketSnapshot, PositionState, SymbolFilters } from "../domain/types.js";
import { MarketIngestor } from "./marketIngestor.js";

const { marketSockets, MockSocket } = vi.hoisted(() => {
  class MockSocket {
    public closeCalls = 0;
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    public constructor(public readonly url?: string) {}

    public on(event: string, handler: (...args: unknown[]) => void): this {
      const existing = this.handlers.get(event) ?? [];
      existing.push(handler);
      this.handlers.set(event, existing);
      return this;
    }

    public close(): void {
      this.closeCalls += 1;
      this.emit("close");
    }

    public emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return {
    marketSockets: [] as MockSocket[],
    MockSocket
  };
});

vi.mock("ws", () => ({
  default: class extends MockSocket {
    public constructor(url: string) {
      super(url);
      marketSockets.push(this);
    }
  }
}));

const config: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  logLevel: "silent",
  tradingMode: "live",
  symbol: "BTCUSDT",
  binance: {
    restBaseUrl: "https://example.test",
    wsBaseUrl: "wss://example.test/stream",
    apiKey: "",
    apiSecret: ""
  },
  postgresUrl: "postgres://example",
  redisUrl: "redis://example",
  telegram: {},
  feeds: {
    news: [],
    macro: []
  },
  onchainBaseUrl: "https://example.test/api",
  riskPolicy: {
    maxLeverage: 3,
    riskPerTrade: 0.01,
    maxDailyLoss: 0.02,
    maxWeeklyDrawdown: 0.05,
    maxOpenPositions: 1,
    cooldownMinutes: 60,
    minRiskReward: 1.5
  },
  slippageBps: 3,
  takerFeeBps: 4,
  paperStartingBalance: 10_000,
  codex: {
    timeoutMs: 1_000,
    model: "gpt-5.1-codex",
    useCliFallback: false
  }
};

const filters: SymbolFilters = {
  tickSize: 0.1,
  stepSize: 0.001,
  minQty: 0.001
};

const snapshot: MarketSnapshot = {
  symbol: "BTCUSDT",
  markPrice: 100_000,
  indexPrice: 100_000,
  lastPrice: 100_000,
  bestBid: 99_999,
  bestAsk: 100_001,
  spreadBps: 0.2,
  fundingRate: 0.0001,
  nextFundingTime: 123_456_789,
  openInterest: 10,
  openInterestChangePct1m: 0,
  topTraderLongShortRatio: 1.1,
  volume1m: 1,
  priceChangePct1m: 0,
  priceChangePct5m: 0,
  priceChangePct15m: 0,
  priceChangePct1h: 0,
  intradayHigh: 100_000,
  intradayLow: 100_000,
  distanceFromIntradayHighPct: 0,
  distanceFromIntradayLowPct: 0,
  emaFast: 100_000,
  emaMedium: 100_000,
  trendStrengthPct: 0,
  volumeAcceleration: 1,
  timestamp: 123_456_789,
  filters
};

const accountState: AccountState = {
  equity: 10_000,
  walletBalance: 10_000,
  availableBalance: 10_000,
  dailyPnl: 0,
  weeklyDrawdown: 0,
  consecutiveLosses: 0,
  openOrders: 0,
  updatedAt: 123_456_789
};

const positionState: PositionState = {
  side: "flat",
  quantity: 0,
  entryPrice: 0,
  markPrice: 0,
  leverage: 1,
  unrealizedPnl: 0,
  realizedPnl: 0
};

type ClientMocks = {
  composeInitialMarketSnapshot: ReturnType<typeof vi.fn>;
  connectUserStream: ReturnType<typeof vi.fn>;
  getBalanceState: ReturnType<typeof vi.fn>;
  getCombinedMarketStreamUrl: ReturnType<typeof vi.fn>;
  getMarkPrice: ReturnType<typeof vi.fn>;
  getOpenInterest: ReturnType<typeof vi.fn>;
  getPositionState: ReturnType<typeof vi.fn>;
  getRecentKlines: ReturnType<typeof vi.fn>;
  getSymbolFilters: ReturnType<typeof vi.fn>;
  getTopTraderLongShortRatio: ReturnType<typeof vi.fn>;
  startUserStream: ReturnType<typeof vi.fn>;
  startUserStreamKeepalive: ReturnType<typeof vi.fn>;
  stopUserStreamKeepalive: ReturnType<typeof vi.fn>;
};

const createClient = (): { client: ClientMocks; userSocket: InstanceType<typeof MockSocket> } => {
  const userSocket = new MockSocket("wss://example.test/user");
  const client = {
    getSymbolFilters: vi.fn().mockResolvedValue(filters),
    composeInitialMarketSnapshot: vi.fn().mockResolvedValue(snapshot),
    getRecentKlines: vi.fn().mockResolvedValue([
      {
        openTime: 1,
        high: 100_000,
        low: 100_000,
        close: 100_000,
        volume: 1,
        closeTime: 1
      }
    ]),
    getMarkPrice: vi.fn().mockResolvedValue({
      markPrice: 100_000,
      indexPrice: 100_000,
      fundingRate: 0.0001,
      nextFundingTime: 123_456_789
    }),
    getOpenInterest: vi.fn().mockResolvedValue(11),
    getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1.1),
    getBalanceState: vi.fn().mockResolvedValue(accountState),
    getPositionState: vi.fn().mockResolvedValue(positionState),
    startUserStream: vi.fn().mockResolvedValue("listen-key"),
    startUserStreamKeepalive: vi.fn(),
    stopUserStreamKeepalive: vi.fn(),
    getCombinedMarketStreamUrl: vi.fn().mockReturnValue("wss://example.test/market"),
    connectUserStream: vi.fn().mockReturnValue(userSocket)
  };

  return { client, userSocket };
};

beforeEach(() => {
  vi.useFakeTimers();
  marketSockets.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MarketIngestor", () => {
  it("does not reconnect sockets after intentional stop", async () => {
    const { client, userSocket } = createClient();
    const ingestor = new MarketIngestor(
      config,
      client as never,
      { warn: vi.fn() } as unknown as Logger,
      {
        onMarket: vi.fn(),
        onAccount: vi.fn(),
        onPosition: vi.fn()
      }
    );

    await ingestor.start();

    expect(marketSockets).toHaveLength(1);
    expect(client.startUserStream).toHaveBeenCalledTimes(1);

    await ingestor.stop();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(marketSockets).toHaveLength(1);
    expect(marketSockets[0]?.closeCalls).toBe(1);
    expect(userSocket.closeCalls).toBe(1);
    expect(client.startUserStream).toHaveBeenCalledTimes(1);
    expect(client.stopUserStreamKeepalive).toHaveBeenCalledTimes(1);
  });

  it("clears queued reconnect timers during stop", async () => {
    const { client, userSocket } = createClient();
    const ingestor = new MarketIngestor(
      config,
      client as never,
      { warn: vi.fn() } as unknown as Logger,
      {
        onMarket: vi.fn(),
        onAccount: vi.fn(),
        onPosition: vi.fn()
      }
    );

    await ingestor.start();

    marketSockets[0]?.emit("close");
    userSocket.emit("close");

    await ingestor.stop();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(marketSockets).toHaveLength(1);
    expect(client.startUserStream).toHaveBeenCalledTimes(1);
  });
});
