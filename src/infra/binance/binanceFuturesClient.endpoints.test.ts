import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { BinanceFuturesClient } from "./binanceFuturesClient.js";

const sockets = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("ws", () => ({ default: class extends EventEmitter {
  constructor(url: string) { super(); sockets.urls.push(url); }
}}));
const client = (base: string) => new BinanceFuturesClient(
  "https://exchange.invalid", base, "", "", { warn: vi.fn() } as unknown as Logger
);

describe("configured Binance WebSocket endpoints", () => {
  it.each([
    ["wss://fstream.binance.com/stream", "wss://fstream.binance.com/ws/key"],
    ["wss://testnet.invalid:9443/stream", "wss://testnet.invalid:9443/ws/key"],
    ["wss://proxy.invalid/gateway/stream/", "wss://proxy.invalid/gateway/ws/key"],
    ["wss://proxy.invalid/gateway", "wss://proxy.invalid/gateway/ws/key"],
    ["wss://proxy.invalid", "wss://proxy.invalid/ws/key"]
  ])("routes authenticated traffic through %s", (base, expected) => {
    client(base).connectUserStream("key", vi.fn());
    expect(sockets.urls.at(-1)).toBe(expected);
  });

  it("removes combined-stream queries and fragments from the private URL and encodes the key", () => {
    client("wss://proxy.invalid/prefix/stream?streams=old&mode=public#ignored")
      .connectUserStream("key/with?reserved#chars", vi.fn());
    expect(sockets.urls.at(-1)).toBe("wss://proxy.invalid/prefix/ws/key%2Fwith%3Freserved%23chars");
  });

  it("uses the configured public path and replaces an existing stream selection", () => {
    const url = new URL(client("wss://proxy.invalid/prefix/stream?mode=public&streams=old#ignored")
      .getCombinedMarketStreamUrl("BTCUSDT"));
    expect(url.origin).toBe("wss://proxy.invalid");
    expect(url.pathname).toBe("/prefix/stream");
    expect(url.searchParams.get("mode")).toBe("public");
    expect(url.searchParams.getAll("streams")).toEqual([
      "btcusdt@markPrice@1s/btcusdt@bookTicker/btcusdt@kline_1m"
    ]);
    expect(url.hash).toBe("");
  });
});
