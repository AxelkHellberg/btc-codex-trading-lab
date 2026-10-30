import { createHmac } from "node:crypto";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinanceFuturesClient } from "./binanceFuturesClient.js";

const sockets = vi.hoisted(() => ({items: [] as import("node:events").EventEmitter[]}));
vi.mock("ws", async () => {
  const {EventEmitter} = await import("node:events");
  return {default: class extends EventEmitter {
    constructor(public url: string) {super(); sockets.items.push(this);}
  }};
});
const time=1_800_000_000_000;
const base="https://exchange.invalid";
const key="synthetic-test-key";
const secret="synthetic-test-secret";
const logger={warn:vi.fn()};
let fetchMock: ReturnType<typeof vi.fn>;
let client: BinanceFuturesClient;
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(time);
  fetchMock=vi.fn().mockResolvedValue(new Response("{}",{status:200}));
  vi.stubGlobal("fetch",fetchMock);logger.warn.mockReset();sockets.items=[];
  client=new BinanceFuturesClient(base,"wss://stream.invalid/stream",key,secret,logger as unknown as Logger);
});
afterEach(()=>{client.stopUserStreamKeepalive();vi.useRealTimers();vi.unstubAllGlobals();});
const reply=(value:unknown)=>fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value),{status:200}));
const request=()=>{
  const [url,init]=fetchMock.mock.calls.at(-1)! as [string,RequestInit];
  return {url:new URL(url),init};
};
const assertSignature=(params:URLSearchParams)=>{
  const entries=[...params];expect(params.get("timestamp")).toBe(String(time));
  expect(entries.at(-1)?.[0]).toBe("signature");
  const signature=params.get("signature");params.delete("signature");
  expect(signature).toBe(createHmac("sha256",secret).update(params.toString()).digest("hex"));
};
describe("Binance adapter public request contracts",()=>{
  it("uses the configured combined stream endpoint and lower-case symbol",()=>{
    expect(client.getCombinedMarketStreamUrl("BTCUSDT")).toBe("wss://stream.invalid/stream?streams=btcusdt@markPrice@1s/btcusdt@bookTicker/btcusdt@kline_1m");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("encodes public query values without API-key or signature disclosure",async()=>{
    reply({openInterest:"12.5"});expect(await client.getOpenInterest("BTC USDT&x=y")).toBe(12.5);
    const {url,init}=request();expect(url.origin).toBe(base);expect(url.pathname).toBe("/fapi/v1/openInterest");
    expect([...url.searchParams]).toEqual([["symbol","BTC USDT&x=y"]]);
    expect(new Headers(init.headers).get("X-MBX-APIKEY")).toBeNull();
  });
  it("requests the latest five-minute top-trader ratio",async()=>{
    reply([{longShortRatio:"1.25"}]);expect(await client.getTopTraderLongShortRatio("BTCUSDT")).toBe(1.25);
    const {url}=request();expect(url.pathname).toBe("/futures/data/topLongShortPositionRatio");
    expect(Object.fromEntries(url.searchParams)).toEqual({symbol:"BTCUSDT",period:"5m",limit:"1"});
  });
  it("maps exchange filters and returns undefined for an unknown symbol",async()=>{
    const payload={symbols:[{symbol:"BTCUSDT",filters:[{filterType:"PRICE_FILTER",tickSize:"0.25"},
      {filterType:"LOT_SIZE",stepSize:"0.005",minQty:"0.01"},{filterType:"MIN_NOTIONAL",notional:"25"}]}]};
    reply(payload);expect(await client.getSymbolFilters("BTCUSDT")).toEqual({tickSize:0.25,stepSize:0.005,minQty:0.01,minNotional:25});
    expect(request().url.pathname).toBe("/fapi/v1/exchangeInfo");
    reply(payload);expect(await client.getSymbolFilters("UNKNOWN")).toBeUndefined();
  });
  it("maps mark, index, funding, and funding time separately",async()=>{
    reply({markPrice:"100",indexPrice:"99",lastFundingRate:"0.0001",nextFundingTime:time+1000});
    expect(await client.getMarkPrice("BTCUSDT")).toEqual({markPrice:100,indexPrice:99,fundingRate:0.0001,nextFundingTime:time+1000});
    expect(request().url.pathname).toBe("/fapi/v1/premiumIndex");
  });
  it("maps klines and sends the requested interval and limit",async()=>{
    reply([[time,"99","105","95","102","4",time+59_999,"0",2,"0","0","0"]]);
    expect(await client.getRecentKlines("BTCUSDT","1m",10)).toEqual([{openTime:time,closeTime:time+59_999,high:105,low:95,close:102,volume:4}]);
    expect(request().url.pathname).toBe("/fapi/v1/klines");
    expect(Object.fromEntries(request().url.searchParams)).toEqual({symbol:"BTCUSDT",interval:"1m",limit:"10"});
  });
});
describe("signed request wire contracts",()=>{
  it("signs GET parameters and sends API auth only in the header",async()=>{
    reply([]);await client.getPositionState("BTC USDT&x=y");
    const {url,init}=request();expect(url.pathname).toBe("/fapi/v3/positionRisk");
    expect(init.method??"GET").toBe("GET");expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("X-MBX-APIKEY")).toBe(key);
    expect(url.searchParams.get("symbol")).toBe("BTC USDT&x=y");assertSignature(url.searchParams);
    expect(url.toString()).not.toContain(secret);expect(url.toString()).not.toContain(key);
  });
  it("signs order POST form bytes, including numeric and boolean parameters",async()=>{
    await client.createOrder({symbol:"BTCUSDT",side:"BUY",quantity:0.25,reduceOnly:true,newClientOrderId:"sample & id"});
    const {url,init}=request();expect(url.pathname).toBe("/fapi/v1/order");expect(url.search).toBe("");
    expect(init.method).toBe("POST");expect(new Headers(init.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new Headers(init.headers).get("X-MBX-APIKEY")).toBe(key);
    const body=new URLSearchParams(String(init.body));expect(body.get("quantity")).toBe("0.25");
    expect(body.get("reduceOnly")).toBe("true");expect(body.get("newClientOrderId")).toBe("sample & id");assertSignature(body);
  });
  it("sends leverage as a signed form POST",async()=>{
    await client.changeLeverage("BTCUSDT",3);const {url,init}=request();
    expect(url.pathname).toBe("/fapi/v1/leverage");expect(init.method).toBe("POST");
    const body=new URLSearchParams(String(init.body));expect(body.get("leverage")).toBe("3");assertSignature(body);
  });
  it("sends signed DELETE parameters in the URL with no form body",async()=>{
    await client.cancelAllOrders("BTCUSDT");const {url,init}=request();
    expect(url.pathname).toBe("/fapi/v1/allOpenOrders");expect(init.method).toBe("DELETE");expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).get("X-MBX-APIKEY")).toBe(key);expect(url.searchParams.get("symbol")).toBe("BTCUSDT");assertSignature(url.searchParams);
  });
  it("maps balance equity and available funds from the USDT entry",async()=>{
    reply([{asset:"USDC",balance:"500"},{asset:"USDT",balance:"100",availableBalance:"75",crossWalletBalance:"100",crossUnPnl:"-5",updateTime:time}]);
    expect(await client.getBalanceState()).toMatchObject({equity:95,walletBalance:100,availableBalance:75,updatedAt:time});
    expect(request().url.pathname).toBe("/fapi/v3/balance");assertSignature(request().url.searchParams);
  });
  it.each([["2","long"],["-2","short"]] as const)("maps signed position quantity %s to %s",async(amount,side)=>{
    reply([{symbol:"BTCUSDT",positionAmt:amount,entryPrice:"100",markPrice:"101",unRealizedProfit:"2",liquidationPrice:"50",leverage:"3",updateTime:time}]);
    expect(await client.getPositionState("BTCUSDT")).toMatchObject({side,quantity:2,entryPrice:100,markPrice:101,leverage:3,unrealizedPnl:2,openedAt:time});
  });
  it("returns a flat position when the requested symbol has no exposure",async()=>{
    reply([]);expect(await client.getPositionState("BTCUSDT")).toMatchObject({side:"flat",quantity:0});
  });
  it("propagates HTTP failures rather than treating them as order acceptance",async()=>{
    fetchMock.mockResolvedValueOnce(new Response("rejected",{status:429}));
    await expect(client.createOrder({symbol:"BTCUSDT"})).rejects.toMatchObject({status:429});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
describe("user-stream lifecycle contracts",()=>{
  it("starts a listen key with unsigned API-key POST",async()=>{
    reply({listenKey:"synthetic-key"});expect(await client.startUserStream()).toBe("synthetic-key");
    const {url,init}=request();expect(url.pathname).toBe("/fapi/v1/listenKey");expect(url.search).toBe("");
    expect(init.method).toBe("POST");expect(init.body).toBeUndefined();expect(new Headers(init.headers).get("X-MBX-APIKEY")).toBe(key);
  });
  it("replaces the keepalive timer and uses only the current listen key",async()=>{
    client.startUserStreamKeepalive("old");await vi.advanceTimersByTimeAsync(10*60_000);
    client.startUserStreamKeepalive("current & key");await vi.advanceTimersByTimeAsync(40*60_000);
    expect(fetchMock).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(10*60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);const {url,init}=request();
    expect(url.pathname).toBe("/fapi/v1/listenKey");expect(url.search).toBe("");expect(init.method).toBe("PUT");
    expect(new URLSearchParams(String(init.body)).get("listenKey")).toBe("current & key");
    expect(new Headers(init.headers).get("X-MBX-APIKEY")).toBe(key);
    client.stopUserStreamKeepalive();await vi.advanceTimersByTimeAsync(100*60_000);expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("observes keepalive rejection without starting extra timers",async()=>{
    fetchMock.mockRejectedValue(new Error("synthetic failure"));client.startUserStreamKeepalive("key");
    await vi.advanceTimersByTimeAsync(50*60_000);expect(logger.warn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);client.stopUserStreamKeepalive();expect(vi.getTimerCount()).toBe(0);
  });
  it("parses user messages and contains malformed JSON without network sockets",()=>{
    const onMessage=vi.fn();client.connectUserStream("synthetic-key",onMessage);
    const socket=sockets.items[0];socket.emit("message",Buffer.from('{"e":"ACCOUNT_UPDATE"}'));
    expect(onMessage).toHaveBeenCalledExactlyOnceWith({e:"ACCOUNT_UPDATE"});
    socket.emit("message",Buffer.from("invalid"));expect(logger.warn).toHaveBeenCalledOnce();expect(onMessage).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
