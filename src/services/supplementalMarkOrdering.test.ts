import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import type { DecisionContext, ExecutionPlan, MarketSnapshot } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import { PaperBroker } from "./brokers.js";
import { MarketIngestor } from "./marketIngestor.js";

const initial: MarketSnapshot = {
  symbol: "BTCUSDT", markPrice: 100_000, indexPrice: 100_000, lastPrice: 100_000,
  bestBid: 100_000, bestAsk: 100_001, spreadBps: 0.1, fundingRate: 0,
  nextFundingTime: 1_800_000_000_000, openInterest: 10, openInterestChangePct1m: 0,
  topTraderLongShortRatio: 1, volume1m: 0, priceChangePct1m: 0, priceChangePct5m: 0,
  priceChangePct15m: 0, priceChangePct1h: 0, intradayHigh: 100_000, intradayLow: 100_000,
  distanceFromIntradayHighPct: 0, distanceFromIntradayLowPct: 0, emaFast: 100_000,
  emaMedium: 100_000, trendStrengthPct: 0, volumeAcceleration: 1, timestamp: 1
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};
const fixture = (onMarket: (snapshot: MarketSnapshot) => Promise<void> | void = () => {}) => {
  const client = {
    getMarkPrice: vi.fn().mockResolvedValue({ markPrice: 100_000, indexPrice: 99_999, fundingRate: 0.01, nextFundingTime: 10 }),
    getOpenInterest: vi.fn().mockResolvedValue(11),
    getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1.2)
  };
  const ingestor = new MarketIngestor(
    { ...config, tradingMode: "paper" }, client as unknown as BinanceFuturesClient,
    { warn: vi.fn() } as unknown as Logger,
    { onMarket, onAccount: vi.fn(), onPosition: vi.fn() }
  );
  const internal = ingestor as unknown as {
    snapshot: MarketSnapshot;
    refreshSupplemental(): Promise<void>;
    handleMarketMessage(raw: string): Promise<void>;
  };
  internal.snapshot = { ...initial };
  const tick = (price: number) => internal.handleMarketMessage(JSON.stringify({
    data: { e: "markPriceUpdate", p: String(price), i: String(price + 1), r: "0.002", T: 20, E: 2 }
  }));
  return { internal, client, tick };
};

describe("supplemental mark ordering", () => {
  it("retains a WebSocket mark accepted while the REST mark request is pending", async () => {
    const { internal, client, tick } = fixture();
    const mark = deferred<Awaited<ReturnType<BinanceFuturesClient["getMarkPrice"]>>>();
    client.getMarkPrice.mockReturnValue(mark.promise);
    const pending = internal.refreshSupplemental();
    await vi.waitFor(() => expect(client.getMarkPrice).toHaveBeenCalledOnce());
    await tick(101_050);
    mark.resolve({ markPrice: 100_000, indexPrice: 99_999, fundingRate: 0.01, nextFundingTime: 10 });
    await pending;
    expect(internal.snapshot).toMatchObject({ markPrice: 101_050, indexPrice: 101_051, fundingRate: 0.002, nextFundingTime: 20, openInterest: 11 });
  });

  it("keeps protective ticks flowing while a ratio request delays an older REST mark", async () => {
    const broker = new PaperBroker({ ...config, tradingMode: "paper", takerFeeBps: 0, slippageBps: 0 });
    const plan: ExecutionPlan = {
      action: "LONG", side: "BUY", entryType: "MARKET", leverage: 2, quantity: 0.02,
      notionalUsd: 2_000, entryPrice: 100_000, stopLoss: 99_000, tp1: 101_500, tp2: 103_000,
      breakEvenTriggerR: 1, trailingTriggerR: 2, trailingOffset: 1_000, initialRiskPerUnit: 1_000,
      maxHoldUntil: Date.now() + 60_000, confidence: 0.8, setupType: "breakout", regimeAtEntry: "trend_up",
      entryReason: "fixture", reasoningSummary: "fixture", invalidationPrice: 99_000
    };
    // execute only reads the market snapshot for this paper entry.
    expect((await broker.execute(plan, { market_snapshot: initial } as DecisionContext)).accepted).toBe(true);
    const exits: unknown[] = [];
    const { internal, client, tick } = fixture(async (snapshot) => {
      const result = await broker.onMarketSnapshot(snapshot);
      if (result?.tradeRecord?.status === "closed") exits.push(result);
    });
    const ratio = deferred<number>();
    client.getTopTraderLongShortRatio.mockReturnValueOnce(ratio.promise);
    const pending = internal.refreshSupplemental();
    await vi.waitFor(() => expect(client.getMarkPrice).toHaveBeenCalledOnce());
    await tick(101_050);
    expect(broker.getState().positionState.stopLoss).toBe(100_000);
    ratio.resolve(1.2);
    await pending;
    expect(internal.snapshot).toMatchObject({ markPrice: 101_050, openInterest: 11, topTraderLongShortRatio: 1.2 });
    expect(broker.getState().positionState.side).toBe("long");
    expect(exits).toHaveLength(0);
    await tick(99_950);
    await tick(99_900);
    expect(broker.getState().positionState.side).toBe("flat");
    expect(exits).toHaveLength(1);
  });

  it("accepts REST recovery when no mark update intervenes and on a later refresh", async () => {
    const { internal, tick } = fixture();
    await tick(101_050);
    await internal.refreshSupplemental();
    expect(internal.snapshot).toMatchObject({ markPrice: 100_000, indexPrice: 99_999, fundingRate: 0.01, nextFundingTime: 10 });
  });

  it("does not discard a REST mark because an unrelated book update arrived", async () => {
    const { internal, client } = fixture();
    const ratio = deferred<number>();
    client.getTopTraderLongShortRatio.mockReturnValueOnce(ratio.promise);
    const pending = internal.refreshSupplemental();
    await vi.waitFor(() => expect(client.getMarkPrice).toHaveBeenCalledOnce());
    await internal.handleMarketMessage(JSON.stringify({ data: { e: "bookTicker", b: "100100", a: "100101", E: 3 } }));
    ratio.resolve(1.2); await pending;
    expect(internal.snapshot).toMatchObject({ markPrice: 100_000, indexPrice: 99_999, bestBid: 100_100, bestAsk: 100_101 });
  });
});
