import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import type { AccountState, PositionState } from "../domain/types.js";
import { MarketIngestor } from "./marketIngestor.js";

const testConfig: AppConfig = {
  nodeEnv: "test",
  port: 3000,
  logLevel: "info",
  tradingMode: "live",
  symbol: "BTCUSDT",
  binance: {
    restBaseUrl: "https://fapi.binance.com",
    wsBaseUrl: "wss://fstream.binance.com/stream",
    apiKey: "",
    apiSecret: ""
  },
  postgresUrl: "postgres://postgres:postgres@localhost:5432/trader",
  redisUrl: "redis://localhost:6379",
  telegram: {},
  feeds: {
    news: [],
    macro: []
  },
  onchainBaseUrl: "https://mempool.space/api",
  riskPolicy: {
    maxLeverage: 3,
    riskPerTrade: 0.005,
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
    timeoutMs: 45_000,
    model: "gpt-5.1-codex",
    useCliFallback: true
  }
};

const accountState: AccountState = {
  equity: 1000,
  walletBalance: 1000,
  availableBalance: 900,
  dailyPnl: 0,
  weeklyDrawdown: 0,
  consecutiveLosses: 0,
  openOrders: 0,
  updatedAt: 1
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

describe("MarketIngestor", () => {
  it("logs and swallows live user-stream callback failures", async () => {
    const logger = { warn: vi.fn() };
    const ingestor = new MarketIngestor(
      testConfig,
      {
        getBalanceState: vi.fn().mockResolvedValue(accountState),
        getPositionState: vi.fn().mockResolvedValue(positionState)
      } as never,
      logger as never,
      {
        onMarket: vi.fn(),
        onAccount: vi.fn().mockRejectedValue(new Error("account refresh failed")),
        onPosition: vi.fn()
      }
    );

    await expect(
      (ingestor as unknown as { handleUserStreamEvent: (event: unknown) => Promise<void> }).handleUserStreamEvent({
        e: "ACCOUNT_UPDATE"
      })
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
        eventType: "ACCOUNT_UPDATE"
      }),
      "Failed to process user stream event"
    );
  });
});
