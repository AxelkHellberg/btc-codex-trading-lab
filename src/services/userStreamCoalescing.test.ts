import { describe, expect, it, vi } from "vitest";
import { MarketIngestor } from "./marketIngestor.js";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const setup = () => {
  const client = { getBalanceState: vi.fn().mockResolvedValue({ equity: 200 }), getPositionState: vi.fn().mockResolvedValue({ quantity: 0 }), stopUserStreamKeepalive: vi.fn() };
  const callbacks = { onMarket: vi.fn(), onAccount: vi.fn(), onPosition: vi.fn() };
  const ingestor = new MarketIngestor({ symbol: "BTCUSDT" } as never, client as never, { warn: vi.fn() } as never, callbacks);
  const handle = (e = "ACCOUNT_UPDATE") => (ingestor as unknown as { handleUserStreamEvent(e: unknown): Promise<void> }).handleUserStreamEvent({ e });
  return { client, callbacks, ingestor, handle };
};
describe("user stream coalescing", () => {
  it("coalesces a hundred events into one active and one follow-up read pair", async () => {
    const x = setup(); const pending = deferred<{ equity: number }>();
    x.client.getBalanceState.mockReturnValueOnce(pending.promise);
    const work = Array.from({ length: 100 }, (_, n) => x.handle(n % 2 ? "ORDER_TRADE_UPDATE" : "ACCOUNT_UPDATE"));
    expect(x.client.getBalanceState).toHaveBeenCalledOnce(); expect(x.client.getPositionState).toHaveBeenCalledOnce();
    pending.resolve({ equity: 100 }); await Promise.all(work);
    expect(x.client.getBalanceState).toHaveBeenCalledTimes(2); expect(x.client.getPositionState).toHaveBeenCalledTimes(2);
    expect(x.callbacks.onAccount.mock.calls.map(([a]) => a.equity)).toEqual([100, 200]);
    expect(x.callbacks.onPosition).toHaveBeenLastCalledWith({ quantity: 0 });
  });
  it("keeps a slow callback single flight and catches updates arriving during delivery", async () => {
    const x = setup(); const pending = deferred<void>(); x.callbacks.onAccount.mockReturnValueOnce(pending.promise);
    const first = x.handle(); await vi.waitFor(() => expect(x.callbacks.onAccount).toHaveBeenCalledOnce());
    const queued = x.handle(); expect(x.client.getBalanceState).toHaveBeenCalledOnce();
    pending.resolve(); await Promise.all([first, queued]); expect(x.client.getBalanceState).toHaveBeenCalledTimes(2);
  });
  it("drops late reads and queued follow-ups after stop", async () => {
    const x = setup(); const pending = deferred<{ equity: number }>(); x.client.getBalanceState.mockReturnValueOnce(pending.promise);
    const first = x.handle(); const queued = x.handle(); await x.ingestor.stop();
    pending.resolve({ equity: 1 }); await Promise.all([first, queued]);
    expect(x.callbacks.onAccount).not.toHaveBeenCalled(); expect(x.client.getBalanceState).toHaveBeenCalledOnce();
    await x.handle(); expect(x.client.getBalanceState).toHaveBeenCalledOnce();
  });
  it("does not let a retired generation finish into a replacement stream", async () => {
    const x = setup(); const pending = deferred<{ equity: number }>(); x.client.getBalanceState.mockReturnValueOnce(pending.promise);
    const old = x.handle();
    const owned = x.ingestor as unknown as { userStreamGeneration: number }; owned.userStreamGeneration++;
    await x.handle(); pending.resolve({ equity: 1 }); await old;
    expect(x.callbacks.onAccount.mock.calls).toEqual([[{ equity: 200 }]]);
  });
  it("still runs the coalesced follow-up after one component fails", async () => {
    const x = setup(); x.client.getBalanceState.mockRejectedValueOnce(new Error("offline"));
    await Promise.all([x.handle(), x.handle("ORDER_TRADE_UPDATE")]);
    expect(x.client.getBalanceState).toHaveBeenCalledTimes(2);
    expect(x.callbacks.onAccount).toHaveBeenCalledOnce(); expect(x.callbacks.onPosition).toHaveBeenCalledTimes(2);
    await x.handle(); expect(x.client.getBalanceState).toHaveBeenCalledTimes(3);
  });
  it("retains an event arriving between drain settlement and batch cleanup", async () => {
    const x = setup();
    type Batch = { generation: number; dirty: boolean; eventType: string };
    const owned = x.ingestor as unknown as { drainUserRefreshes(batch: Batch): Promise<void> };
    const drain = owned.drainUserRefreshes.bind(owned);
    let queued: Promise<void> | undefined;
    vi.spyOn(owned, "drainUserRefreshes").mockImplementationOnce(batch => {
      const work = drain(batch);
      void work.then(() => { queued = x.handle("ORDER_TRADE_UPDATE"); });
      return work;
    });
    await x.handle(); await queued;
    expect(x.client.getBalanceState).toHaveBeenCalledTimes(2);
    expect(x.callbacks.onAccount).toHaveBeenCalledTimes(2);
  });

});
