import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { OnchainIngestor } from "./onchainIngestor.js";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("mempool transaction-count boundary", () => {
  it.each([null, [], {}, { count: null }, { count: "12" }, { count: "secret-invalid" },
    { count: -1 }, { count: 1.5 }, { count: Number.MAX_SAFE_INTEGER + 1 }, { count: false }])(
    "rejects %j without changing the last successful cadence or fee baseline", async (bad) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      let mempool: unknown = { count: 10 };
      let height = 100;
      let fastestFee = 5;
      vi.stubGlobal("fetch", vi.fn(async (input: string) => {
        if (input.endsWith("/mempool")) return new Response(JSON.stringify(mempool));
        if (input.endsWith("/height")) return new Response(String(height));
        if (input.endsWith("/recommended")) return new Response(JSON.stringify({ fastestFee, halfHourFee: 4, hourFee: 3 }));
        return new Response(JSON.stringify({ progressPercent: 25, difficultyChange: -2 }));
      }));
      const publish = vi.fn();
      const warn = vi.fn();
      const ingestor = new OnchainIngestor({ onchainBaseUrl: "https://example.test" } as AppConfig, { warn } as unknown as Logger, publish);
      const internal = ingestor as unknown as { poll(): Promise<void>; lastHeight: number; lastHeightAt: number; lastFees: number };
      await internal.poll();
      const baseline = [internal.lastHeight, internal.lastHeightAt, internal.lastFees];
      mempool = bad; height = 101; fastestFee = 99;
      vi.setSystemTime(1_060_000);
      await internal.poll();
      expect(publish).toHaveBeenCalledTimes(1);
      expect([internal.lastHeight, internal.lastHeightAt, internal.lastFees]).toEqual(baseline);
      expect(warn).toHaveBeenCalledTimes(1);
      const error = warn.mock.calls[0]?.[0].error as Error;
      expect(error.message).toContain("mempool.count");
      expect(error.message).not.toContain("secret-invalid");
      mempool = { count: 0 }; height = 102;
      vi.setSystemTime(1_120_000);
      await internal.poll();
      expect(publish).toHaveBeenCalledTimes(2);
      expect(publish.mock.calls[1]?.[0]).toMatchObject({ mempoolTxCount: 0, blockCadenceSeconds: 60 });
    });

  it("rejects a syntactically valid JSON number that overflows to infinity", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => new Response(input.endsWith("/height") ? "100" :
      input.endsWith("/mempool") ? '{"count":1e999}' : JSON.stringify(input.endsWith("/recommended")
        ? { fastestFee: 5, halfHourFee: 4, hourFee: 3 } : { progressPercent: 25, difficultyChange: -2 }))));
    const publish = vi.fn();
    const warn = vi.fn();
    const ingestor = new OnchainIngestor({ onchainBaseUrl: "https://example.test" } as AppConfig, { warn } as unknown as Logger, publish);
    await (ingestor as unknown as { poll(): Promise<void> }).poll();
    expect(publish).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0].error.message).toContain("mempool.count");
  });

  it.each([0, 1, Number.MAX_SAFE_INTEGER])("accepts the safe nonnegative integer %s", async (count) => {
    vi.stubGlobal("fetch", vi.fn(async (input: string) => new Response(input.endsWith("/height") ? "100" : JSON.stringify(
      input.endsWith("/mempool") ? { count } : input.endsWith("/recommended") ? { fastestFee: 5, halfHourFee: 4, hourFee: 3 } : { progressPercent: 25, difficultyChange: -2 }
    ))));
    const publish = vi.fn();
    const ingestor = new OnchainIngestor({ onchainBaseUrl: "https://example.test" } as AppConfig, { warn: vi.fn() } as unknown as Logger, publish);
    await (ingestor as unknown as { poll(): Promise<void> }).poll();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ mempoolTxCount: count }));
  });
});
