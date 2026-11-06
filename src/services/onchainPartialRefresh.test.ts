import type { Logger } from "pino";
import { afterEach, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { OnchainIngestor } from "./onchainIngestor.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup() {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  const fixture = { failed: "", height: 900000, difficulty: -3, fee: 40 };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (fixture.failed && url.endsWith(fixture.failed)) throw new Error("endpoint unavailable");
    return { ok: true, json: async () => url.endsWith("/mempool") ? { count: 25 }
      : url.endsWith("/recommended") ? { fastestFee: fixture.fee, halfHourFee: 20, hourFee: 10 }
      : { difficultyChange: fixture.difficulty }, text: async () => String(fixture.height) };
  }));
  const publish = vi.fn(); const warn = vi.fn();
  const ingestor = new OnchainIngestor({ onchainBaseUrl: "https://example.invalid" } as AppConfig, { warn } as unknown as Logger, publish);
  return { fixture, publish, warn, ingestor };
}

it("publishes fresh core fields when difficulty is unavailable on the first poll", async () => {
  const { fixture, publish, warn, ingestor } = setup(); fixture.failed = "/difficulty-adjustment";
  await ingestor.start(); ingestor.stop();
  expect(publish).toHaveBeenCalledOnce();
  expect(publish.mock.calls[0]![0]).toMatchObject({ fastestFee: 40, tipHeight: 900000, difficultyAdjustment: null });
  expect(warn).toHaveBeenCalledOnce();
});
it("does not present a previous difficulty estimate as newly observed", async () => {
  const { fixture, publish, ingestor } = setup(); await ingestor.start();
  fixture.failed = "/difficulty-adjustment"; fixture.height += 2; fixture.fee = 60;
  await vi.advanceTimersByTimeAsync(300000); ingestor.stop();
  expect(publish.mock.calls[1]![0]).toMatchObject({ fastestFee: 60, tipHeight: 900002, difficultyAdjustment: null, blockCadenceSeconds: 150 });
});
it("recovers the optional estimate on the next healthy poll", async () => {
  const { fixture, publish, ingestor } = setup(); fixture.failed = "/difficulty-adjustment";
  await ingestor.start(); fixture.failed = ""; fixture.difficulty = 0;
  await vi.advanceTimersByTimeAsync(300000); ingestor.stop();
  expect(publish.mock.calls[1]![0].difficultyAdjustment).toBe(0);
});
it.each(["/mempool", "/recommended", "/height"])("does not publish incomplete core data after %s fails", async (failed) => {
  const { fixture, publish, ingestor } = setup(); await ingestor.start();
  fixture.failed = failed; fixture.height += 10;
  await vi.advanceTimersByTimeAsync(300000);
  expect(publish).toHaveBeenCalledOnce();
  fixture.failed = ""; fixture.height = 900002;
  await vi.advanceTimersByTimeAsync(300000); ingestor.stop();
  expect(publish.mock.calls[1]![0].blockCadenceSeconds).toBe(300);
});
