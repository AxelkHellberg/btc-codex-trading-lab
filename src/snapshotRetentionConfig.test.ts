import { afterEach, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
it.each(["0", "-1", "1.5", "Infinity", "NaN", "8761", ""])('rejects invalid snapshot retention setting "%s"', async hours => {
  vi.resetModules(); vi.stubEnv("SNAPSHOT_MARKET_RETENTION_HOURS", hours);
  await expect(import("./config.js")).rejects.toThrow();
});
it("accepts both retention boundaries independently", async () => {
  vi.resetModules(); vi.stubEnv("SNAPSHOT_MARKET_RETENTION_HOURS", "1"); vi.stubEnv("SNAPSHOT_OTHER_RETENTION_HOURS", "8760");
  expect((await import("./config.js")).config.snapshotRetention).toEqual({ marketHours: 1, otherHours: 8760 });
});
