import { EventEmitter } from "node:events";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { MarketIngestor } from "./marketIngestor.js";

const sockets = vi.hoisted(() => ({ all: [] as Array<{ emit(event: string, value: unknown): boolean }> }));
vi.mock("ws", () => ({ default: class extends EventEmitter {
  constructor() { super(); sockets.all.push(this); }
} }));

function fixture() {
  const publish = vi.fn();
  const ingestor = new MarketIngestor({} as AppConfig, {} as BinanceFuturesClient, {} as Logger, {
    onMarket: publish, onAccount() {}, onPosition() {}
  });
  const internal = ingestor as unknown as {
    handleMarketMessage(raw: string): Promise<void>; snapshot: MarketSnapshot; candleHistory: unknown[];
  };
  internal.snapshot = { markPrice: 100, lastPrice: 100 } as MarketSnapshot;
  const event = (k: unknown, E: unknown = 60_000) => JSON.stringify({ stream: "btcusdt@kline_1m", data: { e: "kline", E, k } });
  return { internal, publish, event };
}

const good = { c: "100", h: "110", l: "90", v: "10", x: true };
const malformed: Array<[string, unknown]> = [];
for (const field of ["c", "h", "l", "v"] as const) {
  for (const value of [undefined, null, "", " ", "bad", "Infinity", "NaN", "9".repeat(400), true, [], {}, -1, "-1", "0x10"]) {
    malformed.push([`${field}=${JSON.stringify(value)}`, { ...good, [field]: value }]);
  }
}
for (const field of ["c", "h", "l"] as const) malformed.push([`${field}=0`, { ...good, [field]: "0" }]);
malformed.push(["inverted range", { ...good, h: "89" }], ["close above high", { ...good, c: "111" }],
  ["close below low", { ...good, c: "89" }], ["nonboolean closed", { ...good, x: "true" }],
  ["missing closed", { c: "100", h: "110", l: "90", v: "0" }], ["null candle", null], ["array candle", []]);

describe("streaming candle validation", () => {
  it.each(malformed)("rejects %s for both open and closed updates before state mutation", async (_name, bad) => {
    for (const closed of [false, true]) {
      const { internal, publish, event } = fixture();
      await internal.handleMarketMessage(event(good));
      const snapshot = internal.snapshot;
      const history = [...internal.candleHistory];
      const candidate = bad && typeof bad === "object" && "x" in bad && typeof bad.x === "boolean"
        ? { ...bad, x: closed } : bad;
      await expect(internal.handleMarketMessage(event(candidate, 120_000))).rejects.toThrow("Invalid Binance kline");
      expect(internal.snapshot).toBe(snapshot);
      expect(internal.candleHistory).toEqual(history);
      expect(publish).toHaveBeenCalledTimes(1);
      await internal.handleMarketMessage(event({ ...good, c: "105", v: "0" }, 180_000));
      expect(internal.snapshot).toMatchObject({ lastPrice: 105, volume1m: 0, intradayHigh: 110, intradayLow: 90 });
      expect(Object.values(internal.snapshot).filter((value) => typeof value === "number").every(Number.isFinite)).toBe(true);
    }
  });

  it.each([undefined, null, "120000", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects timestamp %j", async (time) => {
    const { internal, publish, event } = fixture();
    const raw = time === undefined
      ? JSON.stringify({ data: { e: "kline", k: good } })
      : event(good, time);
    await expect(internal.handleMarketMessage(raw)).rejects.toThrow("Invalid Binance kline");
    expect(internal.candleHistory).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("logs a rejected socket candle and publishes the next healthy frame", async () => {
    const warn = vi.fn();
    const publish = vi.fn();
    const client = { getCombinedMarketStreamUrl: () => "wss://example.test" } as unknown as BinanceFuturesClient;
    const ingestor = new MarketIngestor({ symbol: "BTCUSDT" } as AppConfig, client, { warn } as unknown as Logger,
      { onMarket: publish, onAccount() {}, onPosition() {} });
    const internal = ingestor as unknown as { snapshot: MarketSnapshot; connectMarketSocket(): void };
    internal.snapshot = { markPrice: 100, lastPrice: 100 } as MarketSnapshot;
    internal.connectMarketSocket();
    const socket = sockets.all.at(-1)!;
    socket.emit("message", Buffer.from(JSON.stringify({ data: { e: "kline", E: 60000, k: { ...good, h: "secret-invalid" } } })));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(publish).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0].error.message).toBe("Invalid Binance kline field: k.h");
    socket.emit("message", Buffer.from(JSON.stringify({ data: { e: "kline", E: 120000, k: good } })));
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(internal.snapshot.intradayHigh).toBe(110);
  });

  it("accepts valid open and closed zero-volume updates and bounds retained history", async () => {
    const { internal, publish, event } = fixture();
    await internal.handleMarketMessage(event({ ...good, x: false, v: "0" }));
    expect(internal.candleHistory).toHaveLength(0);
    for (let index = 1; index <= 241; index++) await internal.handleMarketMessage(event({ ...good, v: "0" }, index * 60_000));
    expect(internal.candleHistory).toHaveLength(240);
    expect(publish).toHaveBeenCalledTimes(242);
    expect(internal.snapshot).toMatchObject({ lastPrice: 100, volume1m: 0, intradayHigh: 110, intradayLow: 90 });
  });
});
