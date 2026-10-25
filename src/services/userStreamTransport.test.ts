import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { MarketIngestor } from "./marketIngestor.js";

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return { default: class extends EventEmitter { close() {} } };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function start() {
  vi.useFakeTimers();
  const sockets: EventEmitter[] = [];
  const client = {
    getSymbolFilters: vi.fn().mockResolvedValue(undefined),
    composeInitialMarketSnapshot: vi.fn().mockResolvedValue({
      markPrice: 100, lastPrice: 100, openInterest: 1, volume1m: 0
    } satisfies Partial<MarketSnapshot>),
    getRecentKlines: vi.fn().mockResolvedValue([]),
    getMarkPrice: vi.fn().mockResolvedValue({ markPrice: 100, indexPrice: 100 }),
    getOpenInterest: vi.fn().mockResolvedValue(1),
    getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1),
    getBalanceState: vi.fn().mockResolvedValue({}),
    getPositionState: vi.fn().mockResolvedValue({}),
    getCombinedMarketStreamUrl: vi.fn().mockReturnValue("wss://offline.invalid/stream"),
    startUserStream: vi.fn().mockResolvedValue("synthetic-secret-key"),
    startUserStreamKeepalive: vi.fn(),
    stopUserStreamKeepalive: vi.fn(),
    connectUserStream: vi.fn(() => {
      const socket = new EventEmitter();
      sockets.push(socket);
      return socket;
    })
  };
  const warn = vi.fn();
  const ingestor = new MarketIngestor(
    { ...config, tradingMode: "live" }, client as unknown as BinanceFuturesClient,
    { warn } as unknown as Logger,
    { onMarket() {}, onAccount() {}, onPosition() {} }
  );
  await ingestor.start();
  return { sockets, client, warn };
}

describe("live user-stream transport", () => {
  it("observes socket errors without exposing the listen key or URL", async () => {
    const { sockets, warn } = await start();
    const error = Object.assign(new Error("wss://offline.invalid/ws/synthetic-secret-key"), { code: "ECONNRESET" });
    expect(() => sockets[0]!.emit("error", error)).not.toThrow();
    expect(warn).toHaveBeenCalledWith({ code: "ECONNRESET" }, "User stream websocket transport error");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-secret-key");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("wss:");
  });

  it("leaves one reconnect to close and installs a listener on the replacement", async () => {
    const { sockets, client, warn } = await start();
    expect(() => sockets[0]!.emit("error", new Error("offline failure"))).not.toThrow();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(client.connectUserStream).toHaveBeenCalledTimes(1);
    sockets[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(client.connectUserStream).toHaveBeenCalledTimes(2);
    expect(() => sockets[1]!.emit("error", new Error("replacement failure"))).not.toThrow();
    expect(warn).toHaveBeenLastCalledWith({ code: "WEBSOCKET_ERROR" }, "User stream websocket transport error");
  });

  it("does not log arbitrary upstream error codes", async () => {
    const { sockets, warn } = await start();
    sockets[0]!.emit("error", { code: "synthetic-secret-key", message: "private URL" });
    expect(warn).toHaveBeenLastCalledWith({ code: "WEBSOCKET_ERROR" }, "User stream websocket transport error");
  });
});
