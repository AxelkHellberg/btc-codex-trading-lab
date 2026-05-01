import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";

const { fetchJsonMock } = vi.hoisted(() => ({
  fetchJsonMock: vi.fn()
}));

vi.mock("../lib/http.js", () => ({
  fetchJson: fetchJsonMock
}));

import { OnchainIngestor } from "./onchainIngestor.js";

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
      news: [],
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

describe("OnchainIngestor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchJsonMock.mockReset();
    global.fetch = vi.fn().mockResolvedValue({
      text: async () => "100"
    } as Response);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("skips interval ticks while a previous poll is still running", async () => {
    let releaseSecondPoll: (() => void) | null = null;
    const onSnapshot = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseSecondPoll = resolve;
          })
      )
      .mockResolvedValueOnce(undefined);

    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/mempool")) {
        return { count: 12 };
      }

      if (url.endsWith("/v1/fees/recommended")) {
        return { fastestFee: 10, halfHourFee: 5, hourFee: 3 };
      }

      if (url.endsWith("/v1/difficulty-adjustment")) {
        return {
          progressPercent: 42,
          remainingBlocks: 100,
          nextRetargetHeight: 1_000,
          previousRetarget: 123
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const ingestor = new OnchainIngestor(createConfig(), createLogger(), onSnapshot);

    await ingestor.start();
    expect(fetchJsonMock).toHaveBeenCalledTimes(3);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchJsonMock).toHaveBeenCalledTimes(6);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(onSnapshot).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchJsonMock).toHaveBeenCalledTimes(6);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(onSnapshot).toHaveBeenCalledTimes(2);

    releaseSecondPoll?.();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetchJsonMock).toHaveBeenCalledTimes(9);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(onSnapshot).toHaveBeenCalledTimes(3);

    ingestor.stop();
  });
});
