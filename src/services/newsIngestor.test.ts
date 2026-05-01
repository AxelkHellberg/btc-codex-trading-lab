import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";

const { parseUrlMock } = vi.hoisted(() => ({
  parseUrlMock: vi.fn()
}));

vi.mock("rss-parser", () => ({
  default: class Parser {
    public parseURL(feed: string): Promise<unknown> {
      return parseUrlMock(feed);
    }
  }
}));

import { NewsIngestor } from "./newsIngestor.js";

function createConfig(): AppConfig {
  return {
    env: "test",
    mode: "paper",
    logLevel: "silent",
    port: 3000,
    openaiApiKey: "test-key",
    codexModel: "gpt-test",
    codexCliCommand: "codex",
    binanceApiKey: "test-key",
    binanceApiSecret: "test-secret",
    binanceRestBaseUrl: "https://example.com",
    binanceWsBaseUrl: "wss://example.com",
    newsPollIntervalMs: 60_000,
    marketPollIntervalMs: 1_000,
    risk: {
      maxLeverage: 2,
      riskPerTradePct: 0.5,
      dailyLossLimitPct: 2,
      maxConcurrentPositions: 1,
      cooldownMinutes: 15
    },
    broker: {
      paperInitialBalanceUsd: 10_000,
      liveEnabled: false
    },
    feeds: {
      news: ["https://example.com/rss.xml"],
      macro: []
    },
    onchainBaseUrl: "https://example.com",
    telegramBotToken: undefined,
    telegramChatId: undefined
  };
}

function createLogger(): Logger {
  return {
    warn: vi.fn()
  } as unknown as Logger;
}

describe("NewsIngestor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    parseUrlMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips interval ticks while a previous poll is still running", async () => {
    let releaseSecondPoll: (() => void) | null = null;
    const onEvents = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseSecondPoll = resolve;
          })
      )
      .mockResolvedValueOnce(undefined);

    parseUrlMock
      .mockResolvedValueOnce({
        title: "Feed",
        items: [{ title: "Bitcoin ETF inflow 1", link: "https://example.com/1", isoDate: "2026-01-01T00:00:00Z" }]
      })
      .mockResolvedValueOnce({
        title: "Feed",
        items: [{ title: "Bitcoin ETF inflow 2", link: "https://example.com/2", isoDate: "2026-01-01T00:01:00Z" }]
      })
      .mockResolvedValueOnce({
        title: "Feed",
        items: [{ title: "Bitcoin ETF inflow 3", link: "https://example.com/3", isoDate: "2026-01-01T00:02:00Z" }]
      });

    const ingestor = new NewsIngestor(createConfig(), createLogger(), onEvents);

    await ingestor.start();
    expect(parseUrlMock).toHaveBeenCalledTimes(1);
    expect(onEvents).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(parseUrlMock).toHaveBeenCalledTimes(2);
    expect(onEvents).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(parseUrlMock).toHaveBeenCalledTimes(2);
    expect(onEvents).toHaveBeenCalledTimes(2);

    releaseSecondPoll?.();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(parseUrlMock).toHaveBeenCalledTimes(3);
    expect(onEvents).toHaveBeenCalledTimes(3);

    ingestor.stop();
  });
});
