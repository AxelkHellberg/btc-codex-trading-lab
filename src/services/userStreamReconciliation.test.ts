import { describe, expect, it, vi } from "vitest";
import { MarketIngestor } from "./marketIngestor.js";

const account = { equity: 1000, updatedAt: 100 };
const position = { side: "flat", quantity: 0 };
const fixture = () => {
  const client = { getBalanceState: vi.fn().mockResolvedValue(account), getPositionState: vi.fn().mockResolvedValue(position) };
  const callbacks = { onMarket: vi.fn(), onAccount: vi.fn(), onPosition: vi.fn() };
  const logger = { warn: vi.fn() };
  const ingestor = new MarketIngestor({ symbol: "BTCUSDT" } as never, client as never, logger as never, callbacks);
  const handle = (event: unknown = { e: "ACCOUNT_UPDATE" }) => (ingestor as unknown as { handleUserStreamEvent(event: unknown): Promise<void> }).handleUserStreamEvent(event);
  return { client, callbacks, logger, handle };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};

describe("user-stream independent reconciliation", () => {
  it.each(["account", "position"] as const)("delivers the other component after a failed %s read", async (component) => {
    const { client, callbacks, logger, handle } = fixture();
    (component === "account" ? client.getBalanceState : client.getPositionState).mockRejectedValue(new Error("private upstream payload"));
    await expect(handle()).resolves.toBeUndefined();
    expect(component === "account" ? callbacks.onAccount : callbacks.onPosition).not.toHaveBeenCalled();
    expect(component === "account" ? callbacks.onPosition : callbacks.onAccount).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith({ component, eventType: "ACCOUNT_UPDATE", stage: "read" }, "Failed to reconcile user stream component");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private upstream payload");
  });
  it.each(["account", "position"] as const)("contains %s callback failures and delivers the peer", async (component) => {
    const { callbacks, logger, handle } = fixture();
    (component === "account" ? callbacks.onAccount : callbacks.onPosition).mockRejectedValue(new Error("sink failed"));
    await expect(handle({ e: "ORDER_TRADE_UPDATE" })).resolves.toBeUndefined();
    expect(callbacks.onAccount).toHaveBeenCalledWith(account);
    expect(callbacks.onPosition).toHaveBeenCalledWith(position);
    expect(logger.warn).toHaveBeenCalledWith({ component, eventType: "ORDER_TRADE_UPDATE", stage: "callback" }, "Failed to reconcile user stream component");
  });
  it("delivers an available position while the account read is still pending", async () => {
    const { client, callbacks, handle } = fixture();
    const pending = deferred<typeof account>(); client.getBalanceState.mockReturnValue(pending.promise);
    const task = handle();
    await vi.waitFor(() => expect(callbacks.onPosition).toHaveBeenCalledWith(position));
    expect(callbacks.onAccount).not.toHaveBeenCalled();
    pending.resolve(account); await task;
  });
  it("does not let an older user refresh overwrite a newer accepted component", async () => {
    const { client, callbacks, handle } = fixture();
    const old = deferred<typeof account>(); client.getBalanceState.mockReturnValueOnce(old.promise);
    const first = handle(); await handle(); old.resolve({ equity: 900, updatedAt: 1 }); await first;
    expect(callbacks.onAccount.mock.calls).toEqual([[account]]);
  });
  it("contains synchronous client and callback errors", async () => {
    const { client, callbacks, handle } = fixture();
    client.getBalanceState.mockImplementation(() => { throw new Error("read"); });
    callbacks.onPosition.mockImplementation(() => { throw new Error("sink"); });
    await expect(handle()).resolves.toBeUndefined();
  });
  it.each([null, {}, { e: "listenKeyExpired" }])("ignores unrelated or invalid events: %s", async (event) => {
    const { client, handle } = fixture(); await expect(handle(event)).resolves.toBeUndefined();
    expect(client.getBalanceState).not.toHaveBeenCalled(); expect(client.getPositionState).not.toHaveBeenCalled();
  });
});
