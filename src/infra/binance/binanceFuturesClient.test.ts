import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { BinanceFuturesClient } from "./binanceFuturesClient.js";

vi.mock("ws", () => ({
  default: vi.fn().mockImplementation(() => ({
    on: vi.fn()
  }))
}));

const logger = {
  warn: vi.fn()
} as unknown as Logger;

const client = (wsBaseUrl: string): BinanceFuturesClient =>
  new BinanceFuturesClient("https://fapi.binance.com", wsBaseUrl, "api-key", "api-secret", logger);

describe("BinanceFuturesClient", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the configured WebSocket host for combined market streams", () => {
    expect(client("wss://example.test/futures/stream").getCombinedMarketStreamUrl("BTCUSDT")).toBe(
      "wss://example.test/futures/stream?streams=btcusdt@markPrice@1s/btcusdt@bookTicker/btcusdt@kline_1m"
    );
  });

  it("uses the configured WebSocket host for user streams", () => {
    client("wss://example.test/futures/stream").connectUserStream("listen-key", vi.fn());

    expect(WebSocket).toHaveBeenCalledWith("wss://example.test/futures/ws/listen-key");
  });
});
