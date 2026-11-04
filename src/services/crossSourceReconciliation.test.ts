import { describe, expect, it, vi } from "vitest";
import { MarketIngestor } from "./marketIngestor.js";

const oldAccount = { equity: 1000, updatedAt: 100 };
const newAccount = { equity: 1010, updatedAt: 200 };
const oldPosition = { side: "long", quantity: 1 };
const newPosition = { side: "flat", quantity: 0 };
const deferred = <T,>() => {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const rig = () => {
  const accounts = [deferred<typeof oldAccount>(), deferred<typeof oldAccount>()];
  const positions = [deferred<typeof oldPosition>(), deferred<typeof oldPosition>()];
  const client = {
    getBalanceState: vi.fn().mockReturnValueOnce(accounts[0]!.promise).mockReturnValueOnce(accounts[1]!.promise),
    getPositionState: vi.fn().mockReturnValueOnce(positions[0]!.promise).mockReturnValueOnce(positions[1]!.promise),
    getMarkPrice: vi.fn().mockResolvedValue({ markPrice: 100, indexPrice: 100, fundingRate: 0, nextFundingTime: 100 }),
    getOpenInterest: vi.fn().mockResolvedValue(10), getTopTraderLongShortRatio: vi.fn().mockResolvedValue(1),
    stopUserStreamKeepalive: vi.fn()
  };
  const callbacks = { onAccount: vi.fn(), onPosition: vi.fn(), onMarket: vi.fn() };
  const logger = { warn: vi.fn() };
  const ingestor = new MarketIngestor({ symbol: "BTCUSDT", tradingMode: "live" } as never,
    client as never, logger as never, callbacks);
  const internal = ingestor as any;
  internal.snapshot = { markPrice: 100, lastPrice: 100, volume1m: 1, openInterest: 10 };
  const supplemental = () => internal.refreshSupplemental() as Promise<void>;
  const user = () => internal.handleUserStreamEvent({ e: "ACCOUNT_UPDATE" }) as Promise<void>;
  const settle = (i: number, fresh: boolean) => { accounts[i]!.resolve(fresh ? newAccount : oldAccount);
    positions[i]!.resolve(fresh ? newPosition : oldPosition); };
  return { client, callbacks, logger, ingestor, supplemental, user, accounts, positions, settle };
};
describe("shared account/position reconciliation ordering", () => {
  it.each(["supplemental", "user"] as const)("drops a delayed older %s result after the other source publishes", async first => {
    const r = rig(); const second = first === "user" ? "supplemental" : "user";
    const older = r[first](); await flush(); const newer = r[second](); await flush();
    r.settle(1, true); await newer; r.settle(0, false); await older;
    expect(r.callbacks.onAccount.mock.calls).toEqual([[newAccount]]);
    expect(r.callbacks.onPosition.mock.calls).toEqual([[newPosition]]);
  });
  it.each(["supplemental", "user"] as const)("retains the newer refresh when older %s finishes first", async first => {
    const r = rig(); const second = first === "user" ? "supplemental" : "user";
    const older = r[first](); await flush(); const newer = r[second](); await flush();
    r.settle(0, false); await older; r.settle(1, true); await newer;
    expect(r.callbacks.onAccount.mock.calls).toEqual([[oldAccount], [newAccount]]);
    expect(r.callbacks.onPosition.mock.calls).toEqual([[oldPosition], [newPosition]]);
  });
  it("versions components independently when the newer account read fails", async () => {
    const r = rig(); const older = r.supplemental(); await flush(); const newer = r.user(); await flush();
    r.accounts[1]!.reject(new Error("private signed data")); r.positions[1]!.resolve(newPosition); await newer;
    r.settle(0, false); await older;
    expect(r.callbacks.onAccount.mock.calls).toEqual([[oldAccount]]);
    expect(r.callbacks.onPosition.mock.calls).toEqual([[newPosition]]);
    expect(JSON.stringify(r.logger.warn.mock.calls)).not.toContain("private signed data");
  });
  it("serializes each component's callbacks so an older slow sink cannot commit after the newer sink", async () => {
    const r = rig(); const sink = deferred<void>(); const persisted: unknown[] = [];
    r.callbacks.onAccount.mockImplementationOnce(async value => { await sink.promise; persisted.push(value); })
      .mockImplementation(async value => { persisted.push(value); });
    const older = r.supplemental(); await flush(); r.settle(0, false); await flush();
    const newer = r.user(); await flush(); r.settle(1, true); await flush();
    expect(r.callbacks.onAccount).toHaveBeenCalledOnce();
    expect(r.callbacks.onPosition).toHaveBeenLastCalledWith(newPosition);
    sink.resolve(); await Promise.all([older, newer]);
    expect(persisted).toEqual([oldAccount, newAccount]);
  });
  it("recovers callback delivery after a failing older sink", async () => {
    const r = rig(); r.callbacks.onAccount.mockRejectedValueOnce(new Error("sink failed"));
    const older = r.supplemental(); await flush(); r.settle(0, false); await older;
    const newer = r.user(); await flush(); r.settle(1, true); await newer;
    expect(r.callbacks.onAccount).toHaveBeenLastCalledWith(newAccount);
    expect(r.callbacks.onPosition).toHaveBeenLastCalledWith(newPosition);
    expect(r.logger.warn).toHaveBeenCalled();
  });
  it("discards queued and late delivery on stop while allowing an already-running callback to finish", async () => {
    const r = rig(); const sink = deferred<void>(); r.callbacks.onAccount.mockReturnValueOnce(sink.promise);
    const older = r.supplemental(); await flush(); r.settle(0, false); await flush();
    const newer = r.user(); await flush(); r.settle(1, true); await flush();
    await r.ingestor.stop(); sink.resolve(); await Promise.all([older, newer]);
    expect(r.callbacks.onAccount.mock.calls).toEqual([[oldAccount]]);
  });
});
