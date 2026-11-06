import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { config } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { MarketIngestor } from "./marketIngestor.js";

const minute = 60000;
const base = Date.UTC(2026, 10, 6);
const at = base + 250 * minute + 20000;
const bar = (i: number, close = 110) => ({ openTime: base + i * minute,
  closeTime: base + (i+1) * minute - 1, close, high: close, low: close, volume: 100 });
type Bar = ReturnType<typeof bar>;
type Inspect = {
  snapshot: MarketSnapshot; candleHistory: Bar[]; historyRepair: Promise<void> | null;
  handleMarketMessage(raw: string): Promise<void>;
  refreshSupplemental(): Promise<void>;
};
const services: MarketIngestor[] = [];
const fixture = () => {
  vi.useFakeTimers(); vi.setSystemTime(at);
  const client = {
    getRecentKlines: vi.fn().mockResolvedValue(Array.from({ length: 240 }, (_, i) => bar(i+10))),
    getMarkPrice: vi.fn().mockResolvedValue({ markPrice: 110, indexPrice: 110, fundingRate: 0, nextFundingTime: at+minute }),
    getOpenInterest: vi.fn().mockResolvedValue(1), getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1),
    stopUserStreamKeepalive: vi.fn()
  };
  const onMarket = vi.fn(); const warn = vi.fn();
  const service = new MarketIngestor({ ...config, tradingMode: "paper" }, client as unknown as BinanceFuturesClient,
    { warn } as unknown as Logger, { onMarket, onAccount: vi.fn(), onPosition: vi.fn() });
  services.push(service);
  const state = service as unknown as Inspect;
  state.snapshot = { symbol: "BTCUSDT", markPrice: 100, lastPrice: 100, volume1m: 100, openInterest: 1 } as MarketSnapshot;
  state.candleHistory = Array.from({ length: 240 }, (_, i) => bar(i, 100));
  return { client, service, state, onMarket, warn };
};
const frame = (close = 110, i = 250, closed = false) => JSON.stringify({ data: {
  e: "kline", E: at, k: { t: base+i*minute, T: base+(i+1)*minute-1,
    c: String(close), h: String(close), l: String(close), v: "100", x: closed }
} });
const mark = () => JSON.stringify({ data: { e: "markPriceUpdate", E: at, p: "110", i: "110", r: "0", T: at+minute } });
const flush = async () => { for (let i=0;i<10;i++) await Promise.resolve(); };
afterEach(async () => { for (const s of services.splice(0)) await s.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("contiguous history recovery", () => {
  it("suppresses gap-derived changes and repairs the missing minutes before resuming", async () => {
    const { state, client, onMarket } = fixture();
    await state.handleMarketMessage(frame());
    expect(onMarket).not.toHaveBeenCalled();
    expect(client.getRecentKlines).toHaveBeenCalledWith(config.symbol, "1m", 240);
    await state.historyRepair;
    await state.handleMarketMessage(frame());
    expect(onMarket).toHaveBeenCalledTimes(1);
    expect(onMarket.mock.calls[0]![0].priceChangePct1m).toBe(0);
    expect(onMarket.mock.calls[0]![0].priceChangePct5m).toBe(0);
    expect(state.candleHistory).toHaveLength(240);
    expect(new Set(state.candleHistory.map(b => b.openTime)).size).toBe(240);
  });
  it("keeps quote and supplemental publications suppressed while a shared repair is pending", async () => {
    const { state, client, onMarket } = fixture();
    client.getRecentKlines.mockReturnValue(new Promise(() => {}));
    await state.handleMarketMessage(frame()); await state.handleMarketMessage(mark());
    await state.refreshSupplemental(); await state.handleMarketMessage(frame());
    expect(client.getRecentKlines).toHaveBeenCalledTimes(1);
    expect(onMarket).not.toHaveBeenCalled();
  });
  it("logs failure and bounds retries without publishing the old history", async () => {
    const { state, client, onMarket, warn } = fixture();
    client.getRecentKlines.mockRejectedValueOnce(new Error("offline"));
    await state.handleMarketMessage(frame()); await flush();
    await state.handleMarketMessage(mark());
    expect(client.getRecentKlines).toHaveBeenCalledTimes(1); expect(onMarket).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    vi.advanceTimersByTime(3001);
    await state.handleMarketMessage(mark()); await state.historyRepair;
    await state.handleMarketMessage(frame()); expect(onMarket).toHaveBeenCalledTimes(1);
  });
  it("preserves a final socket candle arriving while REST is pending", async () => {
    const { state, client } = fixture(); let resolve!: (rows: Bar[]) => void;
    client.getRecentKlines.mockReturnValue(new Promise(r => { resolve = r; }));
    await state.handleMarketMessage(frame());
    await state.handleMarketMessage(frame(115, 249, true));
    resolve(Array.from({ length: 240 }, (_, i) => bar(i+10)));
    await state.historyRepair;
    expect(state.candleHistory.at(-1)).toEqual(bar(249,115));
    expect(state.candleHistory.filter(b => b.openTime === bar(249).openTime)).toHaveLength(1);
  });
  it.each(["stale", "gap", "invalid"])("rejects a %s recovery page without corrupting retained history", async kind => {
    const { state, client, onMarket, warn } = fixture();
    const before = [...state.candleHistory];
    const rows = kind === "stale" ? before : Array.from({ length: 240 }, (_, i) => bar(i+10));
    if (kind === "gap") rows.splice(235,1);
    if (kind === "invalid") rows[235]!.close = NaN;
    client.getRecentKlines.mockResolvedValue(rows);
    await state.handleMarketMessage(frame()); await state.historyRepair;
    expect(state.candleHistory).toEqual(before); expect(onMarket).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
  it("discards recovery results after stop", async () => {
    const { state, client, service, onMarket } = fixture(); let resolve!: (rows: Bar[]) => void;
    client.getRecentKlines.mockReturnValue(new Promise(r => { resolve = r; }));
    const before = [...state.candleHistory];
    await state.handleMarketMessage(frame()); await service.stop();
    resolve(Array.from({ length: 240 }, (_, i) => bar(i+10))); await state.historyRepair;
    expect(state.candleHistory).toEqual(before); expect(onMarket).not.toHaveBeenCalled();
  });
  it("expires a stalled repair without launching overlapping requests or accepting its late page", async () => {
    const { state, client, onMarket, warn } = fixture(); let resolve!: (rows: Bar[]) => void;
    client.getRecentKlines.mockReturnValue(new Promise(r => { resolve = r; }));
    const before = [...state.candleHistory];
    await state.handleMarketMessage(frame()); vi.advanceTimersByTime(10001);
    await state.handleMarketMessage(frame()); expect(client.getRecentKlines).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("10 seconds"));
    resolve(Array.from({ length: 240 }, (_, i) => bar(i+10))); await state.historyRepair;
    expect(state.candleHistory).toEqual(before); expect(onMarket).not.toHaveBeenCalled();
  });
});
