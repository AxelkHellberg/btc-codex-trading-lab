import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import type { MarketSnapshot } from "../domain/types.js";
import type { BinanceFuturesClient } from "../infra/binance/binanceFuturesClient.js";
import type { Logger } from "pino";
import { MarketIngestor } from "./marketIngestor.js";
const now = 1_800_000_000_000;
const fixture = () => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  const snapshot = {symbol:"BTCUSDT", markPrice:100, lastPrice:100, indexPrice:100, timestamp:now,
    openInterest:100, openInterestChangePct1m:0, volume1m:1} as MarketSnapshot;
  const client = {getMarkPrice:vi.fn().mockResolvedValue({markPrice:100,indexPrice:100,fundingRate:0,nextFundingTime:0}),
    getOpenInterest:vi.fn().mockResolvedValue(110), getTopTraderLongShortRatio:vi.fn().mockResolvedValue(1)};
  const onMarket=vi.fn();
  const ingestor = new MarketIngestor({symbol:"BTCUSDT",tradingMode:"paper"} as AppConfig,
    client as unknown as BinanceFuturesClient,{warn:vi.fn()} as unknown as Logger,
    {onMarket,onAccount:vi.fn(),onPosition:vi.fn()});
  const internal=ingestor as unknown as {snapshot:MarketSnapshot; lastOpenInterest:number;
    openInterestBaseline:{value:number;observedAt:number}|null;refreshSupplemental():Promise<void>};
  internal.snapshot=snapshot; internal.lastOpenInterest=100;
  internal.openInterestBaseline={value:100,observedAt:now};
  return {internal,client,onMarket};
};
afterEach(()=>vi.useRealTimers());
describe("one-minute open interest observations",()=>{
  it("suppresses the immediate startup delta while keeping the original baseline",async()=>{
    const {internal}=fixture(); await internal.refreshSupplemental();
    expect(internal.snapshot.openInterest).toBe(110);
    expect(internal.snapshot.openInterestChangePct1m).toBe(0);
    vi.setSystemTime(now+60_000); await internal.refreshSupplemental();
    expect(internal.snapshot.openInterestChangePct1m).toBe(10);
  });
  it("does not publish an early sample as a full minute",async()=>{
    const {internal}=fixture(); vi.setSystemTime(now+59_999); await internal.refreshSupplemental();
    expect(internal.snapshot.openInterestChangePct1m).toBe(0);
  });
  it.each([60_000,61_000,65_000])("accepts a one-minute sample with bounded scheduling delay %i",async(elapsed)=>{
    const {internal}=fixture();vi.setSystemTime(now+elapsed);await internal.refreshSupplemental();
    expect(internal.snapshot.openInterestChangePct1m).toBe(10);
  });
  it.each([65_001,120_000])("suppresses and reprimes a stale baseline %i",async(elapsed)=>{
    const {internal,client}=fixture(); vi.setSystemTime(now+elapsed);await internal.refreshSupplemental();
    expect(internal.snapshot.openInterestChangePct1m).toBe(0);
    client.getOpenInterest.mockResolvedValue(121);vi.setSystemTime(now+elapsed+60_000);
    await internal.refreshSupplemental();expect(internal.snapshot.openInterestChangePct1m).toBe(10);
  });
  it("reprimes after a backwards clock movement",async()=>{
    const {internal}=fixture();vi.setSystemTime(now-1000);await internal.refreshSupplemental();
    expect(internal.snapshot.openInterestChangePct1m).toBe(0);
  });
  it("does not advance the baseline on an upstream read failure",async()=>{
    const {internal,client}=fixture();client.getOpenInterest.mockRejectedValueOnce(new Error("failed"));
    vi.setSystemTime(now+30_000);await internal.refreshSupplemental();
    vi.setSystemTime(now+60_000);await internal.refreshSupplemental();
    expect(internal.snapshot.openInterestChangePct1m).toBe(10);
  });
  it("primes an absent baseline instead of inventing a delta",async()=>{
    const {internal}=fixture();internal.openInterestBaseline=null;
    vi.setSystemTime(now+60_000);await internal.refreshSupplemental();
    expect(internal.snapshot.openInterestChangePct1m).toBe(0);
  });
  it("timestamps the OI response rather than a later slow mark response",async()=>{
    const {internal,client}=fixture();let finish!: (value:unknown)=>void;
    client.getMarkPrice.mockReturnValue(new Promise(resolve=>{finish=resolve;}));
    vi.setSystemTime(now+60_000);const pending=internal.refreshSupplemental();await Promise.resolve();
    vi.setSystemTime(now+120_000);finish({markPrice:100,indexPrice:100,fundingRate:0,nextFundingTime:0});
    await pending;expect(internal.snapshot.openInterestChangePct1m).toBe(10);
  });
  it.each([0,NaN,Infinity])("reprimes after an unusable OI baseline %s",async(value)=>{
    const {internal,client}=fixture();client.getOpenInterest.mockResolvedValueOnce(value);
    vi.setSystemTime(now+60_000);await internal.refreshSupplemental();
    expect(internal.snapshot.openInterestChangePct1m).toBe(0);
    vi.setSystemTime(now+120_000);await internal.refreshSupplemental();expect(internal.snapshot.openInterestChangePct1m).toBe(0);
  });

});
