import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import { OnchainIngestor } from "./onchainIngestor.js";

describe("observed block cadence", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const fixture = () => {
    let height = 900_000;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input.endsWith("/blocks/tip/height")) return new Response(String(height));
      if (input.endsWith("/mempool")) return Response.json({ count: 10 });
      if (input.endsWith("/v1/fees/recommended")) return Response.json({ fastestFee: 10, halfHourFee: 8, hourFee: 6 });
      return Response.json({ progressPercent: 20 });
    }));
    const onSnapshot = vi.fn();
    const ingestor = new OnchainIngestor({ onchainBaseUrl: "https://fixture.invalid" } as AppConfig, { warn: vi.fn() } as never, onSnapshot);
    const poll = async (minutes: number, nextHeight = height) => {
      height = nextHeight;
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 12, minutes)));
      await (ingestor as unknown as { poll(): Promise<void> }).poll();
      return onSnapshot.mock.lastCall![0];
    };
    vi.useFakeTimers();
    return { poll };
  };

  it("measures a new block from the previous height change across equal-height polls", async () => {
    const { poll } = fixture();
    expect((await poll(0)).blockCadenceSeconds).toBe(600);
    await poll(5);
    await poll(10);
    expect((await poll(15, 900_001)).blockCadenceSeconds).toBe(900);
  });

  it("averages multi-block advances using the unchanged timing anchor", async () => {
    const { poll } = fixture();
    await poll(0);
    await poll(5);
    expect((await poll(20, 900_002)).blockCadenceSeconds).toBe(600);
    await poll(25);
    expect((await poll(30, 900_003)).blockCadenceSeconds).toBe(600);
  });

  it("starts a new timing anchor after a lower tip is observed", async () => {
    const { poll } = fixture();
    await poll(0);
    expect((await poll(5, 899_999)).blockCadenceSeconds).toBe(600);
    await poll(10);
    expect((await poll(15, 900_000)).blockCadenceSeconds).toBe(600);
  });
});
