import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../../config.js";
import { MarketIngestor } from "../../services/marketIngestor.js";
import { BinanceFuturesClient } from "./binanceFuturesClient.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture(payload: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload)));
  vi.stubGlobal("fetch", fetchMock);
  const client = new BinanceFuturesClient("https://example.test", "wss://example.test", "test", "test", {} as Logger);
  return { client, fetchMock };
}

describe("successful listen-key response validation", () => {
  it.each([null, [], {}, { listenKey: null }, { listenKey: 123 }, { listenKey: false },
    { listenKey: {} }, { listenKey: "" }, { listenKey: " \t\n" }])("rejects malformed payload %j before opening a user stream", async (payload) => {
    const { client, fetchMock } = fixture(payload);
    const keepalive = vi.spyOn(client, "startUserStreamKeepalive").mockImplementation(() => {});
    const connect = vi.spyOn(client, "connectUserStream").mockImplementation(() => new EventEmitter() as WebSocket);
    const ingestor = new MarketIngestor({} as AppConfig, client, {} as Logger, {
      onMarket() {}, onAccount() {}, onPosition() {}
    });
    const internal = ingestor as unknown as { startUserStream(): Promise<void>; listenKey: string | null };
    await expect(internal.startUserStream()).rejects.toThrow("Invalid Binance listen-key response");
    expect(internal.listenKey).toBeNull();
    expect(keepalive).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns the valid key unchanged without leaking payload values in contract errors", async () => {
    const { client } = fixture({ listenKey: "synthetic-listen-key" });
    await expect(client.startUserStream()).resolves.toBe("synthetic-listen-key");
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ listenKey: { secret: "synthetic-secret" } })));
    const error = await client.startUserStream().catch((value: Error) => value);
    expect(String(error)).toContain("Invalid Binance listen-key response");
    expect(String(error)).not.toContain("synthetic-secret");
  });
});
