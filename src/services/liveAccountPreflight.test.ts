import { describe, expect, it, vi } from "vitest";
import { assertLiveAccountMode } from "./liveAccountPreflight.js";

describe("live account position mode preflight", () => {
  it("rejects hedge mode without relying on nonempty position rows", async () => {
      const client = { getPositionMode: vi.fn().mockResolvedValue(true), getPositionState: vi.fn() };
      // Positions are deliberately not queried: even an empty hedge account is incompatible.
      await expect(assertLiveAccountMode("live", client)).rejects.toThrow(/one-way.*hedge/);
      expect(client.getPositionMode).toHaveBeenCalledOnce();
      expect(client.getPositionState).not.toHaveBeenCalled();
  });
  it("allows a confirmed one-way account", async () => {
    await expect(assertLiveAccountMode("live", { getPositionMode: vi.fn().mockResolvedValue(false) })).resolves.toBeUndefined();
  });
  it("does not query signed account state in paper mode", async () => {
    const client = { getPositionMode: vi.fn().mockRejectedValue(new Error("no credentials")) };
    await expect(assertLiveAccountMode("paper", client)).resolves.toBeUndefined();
    expect(client.getPositionMode).not.toHaveBeenCalled();
  });
  it("propagates query failure instead of enabling live execution", async () => {
    await expect(assertLiveAccountMode("live", { getPositionMode: vi.fn().mockRejectedValue(new Error("mode unavailable")) })).rejects.toThrow("mode unavailable");
  });
});
