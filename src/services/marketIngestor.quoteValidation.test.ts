import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { config } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { MarketIngestor } from "./marketIngestor.js";

const sockets = vi.hoisted(() => ({ instances: [] as { emit: (event: string, raw: string) => void }[] }));
vi.mock("ws", () => ({ default: class {
  private listeners = new Map<string, ((raw: string) => void)[]>();
  constructor() { sockets.instances.push(this); }
  on(event: string, callback: (raw: string) => void) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), callback]);
    return this;
  }
  emit(event: string, raw: string) { for (const callback of this.listeners.get(event) ?? []) callback(raw); }
  close() {}
} }));

const snapshot = (): MarketSnapshot => ({
  symbol: "BTCUSDT",
  markPrice: 100_000,
  indexPrice: 100_000,
  lastPrice: 100_000,
  bestBid: 99_999,
  bestAsk: 100_001,
  spreadBps: 0.2,
  fundingRate: 0.0001,
  nextFundingTime: Date.now() + 60_000,
  openInterest: 500_000,
  openInterestChangePct1m: 0.2,
  topTraderLongShortRatio: 1.1,
  volume1m: 120,
  priceChangePct1m: 0.4,
  priceChangePct5m: 0.8,
  priceChangePct15m: 1.2,
  priceChangePct1h: 2.4,
  intradayHigh: 101000,
  intradayLow: 98000,
  distanceFromIntradayHighPct: 0.99,
  distanceFromIntradayLowPct: 2.04,
  emaFast: 100300,
  emaMedium: 99900,
  trendStrengthPct: 0.4,
  volumeAcceleration: 1.4,
  timestamp: Date.now(),
  filters: {
    tickSize: 0.1,
    stepSize: 0.001,
    minQty: 0.001,
    minNotional: 5
  }
});
const mark = () => ({ e: "markPriceUpdate", p: "100020", i: "100015", r: "0", T: 180000, E: 120000 });
const book = () => ({ e: "bookTicker", b: "100010", a: "100030", E: 120001 });
let ingestor: MarketIngestor;
let onMarket: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.fn>;
let lastGood: MarketSnapshot;

beforeEach(async () => {
  vi.useFakeTimers();
  sockets.instances.length = 0;
  onMarket = vi.fn();
  warn = vi.fn();
  const initial = snapshot();
  const client = {
    getSymbolFilters: vi.fn().mockResolvedValue(initial.filters),
    composeInitialMarketSnapshot: vi.fn().mockResolvedValue(initial),
    getRecentKlines: vi.fn().mockResolvedValue([]),
    getMarkPrice: vi.fn().mockResolvedValue(initial),
    getOpenInterest: vi.fn().mockResolvedValue(initial.openInterest),
    getTopTraderLongShortRatio: vi.fn().mockResolvedValue(initial.topTraderLongShortRatio),
    getCombinedMarketStreamUrl: vi.fn().mockReturnValue("wss://example.invalid/stream"),
    stopUserStreamKeepalive: vi.fn()
  } as unknown as BinanceFuturesClient;
  ingestor = new MarketIngestor({ ...config, tradingMode: "paper" }, client, { warn } as unknown as Logger,
    { onMarket, onAccount: vi.fn(), onPosition: vi.fn() });
  await ingestor.start();
  lastGood = onMarket.mock.calls.at(-1)![0];
  onMarket.mockClear();
});

afterEach(async () => {
  await ingestor.stop();
  vi.useRealTimers();
});

const deliver = async (data: unknown) => {
  sockets.instances[0]!.emit("message", JSON.stringify({ stream: "btcusdt@test", data }));
  // Socket handlers observe rejected promises asynchronously.
  await Promise.resolve();
  await Promise.resolve();
};

const badQuotes = ["", " ", "bad", "NaN", "Infinity", "1e999", "0", "-1", "0x10", null, true, []];
const badTimes = ["120000", null, -1, 0.5, "bad"];

describe("mark-price and book-ticker frame validation", () => {
  const cases: [string, Record<string, unknown>][] = [];
  for (const field of ["p", "i"] as const) for (const value of badQuotes) cases.push([`mark ${field}=${JSON.stringify(value)}`, { ...mark(), [field]: value }]);
  for (const value of ["", " ", "bad", "Infinity", null, true, []]) cases.push([`funding=${JSON.stringify(value)}`, { ...mark(), r: value }]);
  for (const field of ["T", "E"] as const) for (const value of badTimes) cases.push([`mark ${field}=${value}`, { ...mark(), [field]: value }]);
  for (const field of ["b", "a"] as const) for (const value of badQuotes) cases.push([`book ${field}=${JSON.stringify(value)}`, { ...book(), [field]: value }]);
  for (const value of badTimes) cases.push([`book E=${value}`, { ...book(), E: value }]);
  cases.push(["inverted book", { ...book(), b: "100031" }]);
  cases.push(["overflowing spread", { ...book(), b: "5e-324", a: "1e308" }]);
  for (const field of ["p", "i", "r", "T", "E"]) {
    const data: Record<string, unknown> = mark(); delete data[field]; cases.push([`missing mark ${field}`, data]);
  }
  for (const field of ["b", "a", "E"]) {
    const data: Record<string, unknown> = book(); delete data[field]; cases.push([`missing book ${field}`, data]);
  }

  it.each(cases)("keeps accepted state intact for %s and accepts the next healthy frame", async (_label, data) => {
    await deliver(data);
    expect(onMarket).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(lastGood).toEqual(expect.objectContaining({ markPrice: 100000, bestBid: 99999, bestAsk: 100001 }));
    await deliver(book());
    expect(onMarket).toHaveBeenCalledOnce();
    expect(onMarket.mock.calls[0]![0]).toEqual({ ...lastGood, bestBid: 100010, bestAsk: 100030,
      spreadBps: (20 / 100010) * 10000, timestamp: 120001 });
  });

  it.each(["0", "-0.0001", "0.0001"])("accepts finite funding %s and publishes finite fields", async (r) => {
    await deliver({ ...mark(), r });
    expect(onMarket).toHaveBeenCalledOnce();
    expect(onMarket.mock.calls[0]![0]).toMatchObject({ markPrice: 100020, indexPrice: 100015, fundingRate: Number(r), nextFundingTime: 180000, timestamp: 120000 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a locked book with zero spread", async () => {
    await deliver({ ...book(), a: "100010" });
    expect(onMarket.mock.calls[0]![0]).toMatchObject({ bestBid: 100010, bestAsk: 100010, spreadBps: 0 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("identifies the invalid field without logging the upstream value", async () => {
    await deliver({ ...mark(), p: "malformed-upstream-content\nsecond-line" });
    expect(onMarket).not.toHaveBeenCalled();
    const diagnostic = warn.mock.calls[0]![0].error.message;
    expect(diagnostic).toBe("Invalid markPriceUpdate field: p");
    expect(diagnostic).not.toContain("malformed-upstream-content");
  });
});
