import type { Logger } from "pino";
import Parser from "rss-parser";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import { NewsIngestor } from "./newsIngestor.js";

describe("NewsIngestor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs downstream callback failures instead of rejecting the polling loop", async () => {
    vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({
      title: "CoinDesk",
      items: [
        {
          title: "Bitcoin ETF inflow hits record high",
          link: "https://example.com/bitcoin-etf",
          isoDate: "2026-04-28T00:00:00.000Z"
        }
      ]
    });

    const logger = {
      warn: vi.fn(),
      error: vi.fn()
    } as unknown as Logger;
    const onEvents = vi.fn().mockRejectedValue(new Error("store unavailable"));
    const ingestor = new NewsIngestor(createConfig(), logger, onEvents);

    await expect(ingestor.start()).resolves.toBeUndefined();
    ingestor.stop();

    expect(onEvents).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.any(Error),
        eventCount: 1
      }),
      "Failed to process news events"
    );
  });
});

const createConfig = (): AppConfig => ({
  nodeEnv: "test",
  port: 3000,
  logLevel: "silent",
  tradingMode: "paper",
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
    news: ["https://example.com/news.xml"],
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
  paperStartingBalance: 10000,
  codex: {
    timeoutMs: 45_000,
    model: "gpt-5.1-codex",
    useCliFallback: true
  }
});
