import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BinanceFuturesClient } from "./binanceFuturesClient.js";

afterEach(() => vi.unstubAllGlobals());

const client = () => new BinanceFuturesClient(
  "https://offline.invalid", "wss://offline.invalid", "fixture", "fixture",
  { warn: vi.fn() } as unknown as Logger
);

const stubBalance = (overrides: Record<string, unknown>) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([{
    asset: "USDT", balance: "1000", availableBalance: "25",
    crossWalletBalance: "1000", crossUnPnl: "0", updateTime: 1, ...overrides
  }])));
};

describe("Binance balance equity", () => {
  it.each([
    ["-999", 1], ["-1000", 0], ["-1001", -1], ["12.5", 1012.5]
  ])("preserves calculated equity for unrealized PnL %s", async (pnl, equity) => {
    stubBalance({ crossUnPnl: pnl });
    const state = await client().getBalanceState();
    expect(state).toMatchObject({ equity, walletBalance: 1000, availableBalance: 25 });
  });

  it.each([
    { crossWalletBalance: "invalid" },
    { crossUnPnl: "invalid" },
    { crossWalletBalance: "Infinity" },
    { crossUnPnl: "-Infinity" },
    { crossWalletBalance: "" },
    { crossUnPnl: "  " },
    { crossWalletBalance: undefined },
    { crossUnPnl: undefined },
    { crossWalletBalance: null },
    { crossUnPnl: null },
    { crossWalletBalance: "1e308", crossUnPnl: "1e308" }
  ])("rejects invalid or missing equity components (%j)", async (overrides) => {
    stubBalance(overrides);
    await expect(client().getBalanceState()).rejects.toThrow("Invalid Binance USDT equity");
  });

  it("rejects a missing USDT account rather than fabricating a zero account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json([])));
    await expect(client().getBalanceState()).rejects.toThrow("Invalid Binance balance response");
  });
});
