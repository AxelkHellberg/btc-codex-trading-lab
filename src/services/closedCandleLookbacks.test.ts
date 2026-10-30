import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import type { Logger } from "pino";
import { MarketIngestor } from "./marketIngestor.js";

const minute = 60_000;
const start = 1_800_000_000_000;
const snapshot = { symbol: "BTCUSDT", markPrice: 200, lastPrice: 200, indexPrice: 200, openInterest: 10,
  volume1m: 10, timestamp: start + 60 * minute } as MarketSnapshot;
const fixture = () => {
  const callbacks = { onMarket: vi.fn(), onAccount: vi.fn(), onPosition: vi.fn() };
  const client = { getMarkPrice: vi.fn().mockResolvedValue({markPrice: 210, indexPrice: 210, fundingRate: 0, nextFundingTime: 0}),
    getOpenInterest: vi.fn().mockResolvedValue(10), getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1) };
  const ingestor = new MarketIngestor({symbol: "BTCUSDT", tradingMode: "paper"} as AppConfig,
    client as unknown as BinanceFuturesClient, {warn: vi.fn()} as unknown as Logger, callbacks);
  const internal = ingestor as unknown as {snapshot: MarketSnapshot; candleHistory: unknown[];
    handleMarketMessage(raw: string): Promise<void>; refreshSupplemental(): Promise<void>};
  internal.snapshot = {...snapshot};
  internal.candleHistory = Array.from({length: 60}, (_, i) => ({openTime: start + i * minute,
    closeTime: start + (i + 1) * minute - 1, close: 100 + i, high: 200, low: 90, volume: 10}));
  const candle = (closed: boolean, close = 200) => internal.handleMarketMessage(JSON.stringify({stream: "kline", data: {e: "kline",
    E: start + 61 * minute, k: {t: start + 60 * minute, T: start + 61 * minute - 1,
      c: String(close), h: "210", l: "90", v: "20", x: closed}}}));
  return {internal, callbacks, candle};
};
const expected = (current: number, reference: number) => (current - reference) / reference * 100;
const assertChanges = (value: MarketSnapshot, current: number) => {
  for (const [key, ref] of [["priceChangePct1m",159],["priceChangePct5m",155],["priceChangePct15m",145],["priceChangePct1h",100]] as const)
    expect(value[key]).toBeCloseTo(expected(current,ref));
};
describe("closed candle price references", () => {
  it("uses the same previous bars before and after a candle closes", async () => {
    const {internal,candle} = fixture();
    await candle(false); const before = internal.snapshot;
    await candle(true);
    assertChanges(before,200); assertChanges(internal.snapshot,200);
    expect(internal.snapshot.emaFast).toBeCloseTo(before.emaFast);
    expect(internal.snapshot.volumeAcceleration).toBe(before.volumeAcceleration);
  });
  it("does not reset changes after a repeated closed candle", async () => {
    const {internal,candle} = fixture(); await candle(true); await candle(true,201);
    assertChanges(internal.snapshot,201); expect(internal.candleHistory).toHaveLength(61);
  });
  it("keeps the closed trade price references during a supplemental refresh", async () => {
    const {internal,candle} = fixture(); await candle(true); await internal.refreshSupplemental();
    assertChanges(internal.snapshot,200);
  });
  it("advances the reference when the next candle begins", async () => {
    const {internal,candle} = fixture(); await candle(true);
    await internal.handleMarketMessage(JSON.stringify({data:{e:"kline",E:start+61*minute+1,k:{t:start+61*minute,
      T:start+62*minute-1,c:"202",h:"203",l:"200",v:"1",x:false}}}));
    expect(internal.snapshot.priceChangePct1m).toBeCloseTo(1);
  });
  it("returns finite zero changes when there is no prior history", async () => {
    const {internal,candle} = fixture(); internal.candleHistory=[]; await candle(true);
    for (const key of ["priceChangePct1m","priceChangePct5m","priceChangePct15m","priceChangePct1h"] as const)
      expect(internal.snapshot[key]).toBe(0);
  });
});
