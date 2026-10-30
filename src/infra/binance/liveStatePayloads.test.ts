import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BinanceFuturesClient } from "./binanceFuturesClient.js";

const client = () => new BinanceFuturesClient(
  "https://offline.invalid", "wss://offline.invalid", "fixture", "fixture",
  { warn: vi.fn() } as unknown as Logger
);
const balance = { asset: "USDT", balance: "0", availableBalance: "0", crossWalletBalance: "0", crossUnPnl: "0", updateTime: 0 };
const position = { symbol: "BTCUSDT", positionAmt: "-0.5", entryPrice: "100", markPrice: "90", unRealizedProfit: "5", leverage: "2", updateTime: 1800000000000 };
const response = (value: unknown) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
afterEach(() => vi.unstubAllGlobals());

describe("signed Binance live-state boundaries", () => {
  it("preserves a legitimate zero account", async () => {
    response([balance]);
    await expect(client().getBalanceState()).resolves.toMatchObject({ equity: 0, walletBalance: 0, availableBalance: 0, updatedAt: 0 });
  });

  it.each([null, {}, [], [null], [{ ...balance, asset: "OTHER" }], [balance, balance]])(
    "rejects malformed, missing, or duplicate USDT accounts (%j)", async (value) => {
      response(value);
      await expect(client().getBalanceState()).rejects.toThrow(/Invalid Binance balance/);
    }
  );

  it.each([
    { balance: "" }, { balance: "secret-invalid-value" }, { balance: null }, { balance: "Infinity" },
    { availableBalance: "" }, { availableBalance: false }, { availableBalance: "-Infinity" },
    { updateTime: undefined }, { updateTime: -1 }, { updateTime: 1.5 }, { updateTime: "1" }
  ])("rejects invalid account fields (%j)", async (fields) => {
    response([{ ...balance, ...fields }]);
    await expect(client().getBalanceState()).rejects.toThrow(/Invalid Binance balance/);
    await expect(client().getBalanceState()).rejects.not.toThrow("secret-invalid-value");
  });

  it("maps short and long positions and valid zero-valued flat rows", async () => {
    response([position]);
    await expect(client().getPositionState("BTCUSDT")).resolves.toMatchObject({ side: "short", quantity: 0.5, leverage: 2, unrealizedPnl: 5 });
    response([{ ...position, positionAmt: "0.5", unRealizedProfit: "-5" }]);
    await expect(client().getPositionState("BTCUSDT")).resolves.toMatchObject({ side: "long", quantity: 0.5, unrealizedPnl: -5 });
    response([{ ...position, positionAmt: "0", entryPrice: "0", markPrice: "0", updateTime: 0 }]);
    await expect(client().getPositionState("BTCUSDT")).resolves.toMatchObject({ side: "flat", quantity: 0 });
  });

  it("treats an empty position list as no current exposure", async () => {
    response([]);
    await expect(client().getPositionState("BTCUSDT")).resolves.toMatchObject({ side: "flat", quantity: 0 });
  });

  it("accepts the V3 response without the optional leverage field", async () => {
    const { leverage: _leverage, ...v3Position } = position;
    response([v3Position]);
    await expect(client().getPositionState("BTCUSDT")).resolves.toMatchObject({ side: "short", quantity: 0.5, leverage: 1 });
  });

  it.each([
    { positionAmt: "secret-invalid-value" }, { positionAmt: "" }, { positionAmt: null }, { positionAmt: "Infinity" },
    { entryPrice: "0" }, { entryPrice: "-1" }, { markPrice: "0" }, { markPrice: "NaN" },
    { unRealizedProfit: "" }, { unRealizedProfit: "Infinity" }, { leverage: null },
    { leverage: "0" }, { leverage: "1.5" }, { updateTime: -1 }, { updateTime: "1" }
  ])("rejects malformed open positions (%j)", async (fields) => {
    response([{ ...position, ...fields }]);
    await expect(client().getPositionState("BTCUSDT")).rejects.toThrow(/Invalid Binance positionRisk/);
    await expect(client().getPositionState("BTCUSDT")).rejects.not.toThrow("secret-invalid-value");
  });

  it.each([null, {}, [null], [{ ...position, symbol: undefined }], [{ ...position, symbol: "OTHER" }], [position, position]])(
    "rejects invalid or ambiguous position envelopes (%j)", async (value) => {
      response(value);
      await expect(client().getPositionState("BTCUSDT")).rejects.toThrow(/Invalid Binance positionRisk/);
    }
  );

  it("validates a flat row before reporting flat state", async () => {
    response([{ ...position, positionAmt: "0", unRealizedProfit: "bad" }]);
    await expect(client().getPositionState("BTCUSDT")).rejects.toThrow(/Invalid Binance positionRisk/);
  });
});
