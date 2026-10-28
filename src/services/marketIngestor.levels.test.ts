import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import type { Logger } from "pino";
import { MarketIngestor } from "./marketIngestor.js";
import { RuntimeState } from "./runtimeState.js";

const bar = (index: number, high = 101, low = 99) => ({
  close: 100, high, low, volume: 10, closeTime: index * 60_000
});
const snapshot = () => ({
  symbol: "BTCUSDT", markPrice: 100, indexPrice: 100, lastPrice: 100,
  bestBid: 100, bestAsk: 100, spreadBps: 0, fundingRate: 0,
  nextFundingTime: 0, openInterest: 10, openInterestChangePct1m: 0,
  topTraderLongShortRatio: 1, volume1m: 10, priceChangePct1m: 0,
  priceChangePct5m: 0, priceChangePct15m: 0, priceChangePct1h: 0,
  intradayHigh: 100, intradayLow: 100, distanceFromIntradayHighPct: 0,
  distanceFromIntradayLowPct: 0, emaFast: 100, emaMedium: 100,
  trendStrengthPct: 0, volumeAcceleration: 1, timestamp: 0
});
function setup() {
  let latest = snapshot();
  const client = {
    getSymbolFilters: vi.fn(async () => undefined),
    composeInitialMarketSnapshot: vi.fn(async () => snapshot()),
    getRecentKlines: vi.fn(async (_symbol, _interval, limit: number) =>
      Array.from({ length: limit }, (_, i) => bar(i, i === 0 ? 120 : 101, i === 0 ? 80 : 99))),
    getMarkPrice: vi.fn(async () => ({markPrice: 100, indexPrice: 100, fundingRate: 0, nextFundingTime: 0})),
    getOpenInterest: vi.fn(async () => 10),
    getTopTraderLongShortRatio: vi.fn(async () => 1),
    stopUserStreamKeepalive: vi.fn()
  };
  const ingestor = new MarketIngestor(
    {symbol: "BTCUSDT", tradingMode: "paper"} as AppConfig,
    client as unknown as BinanceFuturesClient, {warn: vi.fn()} as unknown as Logger,
    {onMarket: (value) => { latest = value; }, onAccount() {}, onPosition() {}}
  );
  // Exercise startup and message processing without opening a network socket.
  vi.spyOn(ingestor as any, "connectMarketSocket").mockImplementation(() => {});
  const tick = (index: number, high = 101, low = 99, closed = true) =>
    (ingestor as any).handleMarketMessage(JSON.stringify({stream: "fixture", data: {
      e: "kline", E: index * 60_000, k: {c: "100", h: String(high), l: String(low), v: "10", x: closed}
    }}));
  return { ingestor, client, tick, latest: () => latest };
}
afterEach(() => vi.restoreAllMocks());

describe("runtime rolling-day price levels", () => {
  it("seeds 1440 bars and includes extremes older than four hours in decision context", async () => {
    const fixture = setup();
    try {
      await fixture.ingestor.start();
      expect(fixture.client.getRecentKlines).toHaveBeenCalledWith("BTCUSDT", "1m", 1440);
      const market = fixture.latest();
      expect(market.intradayHigh).toBe(120);
      expect(market.intradayLow).toBe(80);
      expect(market.distanceFromIntradayHighPct).toBeCloseTo(100 / 6);
      expect(market.distanceFromIntradayLowPct).toBe(25);
      const runtime = new RuntimeState(1000);
      runtime.setMarket(market);
      const context = runtime.buildDecisionContext(
        {reason: "minute_recheck", priority: 0, details: "fixture", triggeredAt: 0},
        {maxDailyLoss: 0.1, maxWeeklyDrawdown: 0.2, cooldownMinutes: 10}
      )!;
      expect(context.context_summary.key_levels).toEqual({intraday_high: 120, intraday_low: 80});
      expect(context.context_summary.notes.join(" ")).toContain("16.67%");
    } finally { await fixture.ingestor.stop(); }
  });

  it("retains a streamed extreme for 1440 closed bars and expires it at the exact boundary", async () => {
    const fixture = setup();
    try {
      await fixture.ingestor.start();
      await fixture.tick(1440, 130, 70);
      for (let i = 1441; i < 2880; i++) await fixture.tick(i);
      expect(fixture.latest().intradayHigh).toBe(130);
      expect(fixture.latest().intradayLow).toBe(70);
      expect((fixture.ingestor as any).candleHistory).toHaveLength(1440);
      await fixture.tick(2880);
      expect(fixture.latest().intradayHigh).toBe(101);
      expect(fixture.latest().intradayLow).toBe(99);
      expect((fixture.ingestor as any).candleHistory).toHaveLength(1440);
    } finally { await fixture.ingestor.stop(); }
  });

  it("includes a forming candle without evicting closed history", async () => {
    const fixture = setup();
    try {
      await fixture.ingestor.start();
      await fixture.tick(1440, 140, 60, false);
      expect(fixture.latest().intradayHigh).toBe(140);
      expect(fixture.latest().intradayLow).toBe(60);
      expect((fixture.ingestor as any).candleHistory).toHaveLength(1440);
      await fixture.tick(1440, 101, 99, false);
      expect(fixture.latest().intradayHigh).toBe(120);
      expect(fixture.latest().intradayLow).toBe(80);
      expect(fixture.latest().emaFast).toBeCloseTo(100);
      expect(fixture.latest().volumeAcceleration).toBe(1);
    } finally { await fixture.ingestor.stop(); }
  });
});
