import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { OnchainIngestor } from "./onchainIngestor.js";

describe("OnchainIngestor difficulty adjustment", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  function setup(difficulty: unknown) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T09:00:00Z"));
    const fixture = { difficulty, height: 900000 };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const payload = url.endsWith("/mempool") ? { count: 100 }
        : url.endsWith("/v1/fees/recommended") ? { fastestFee: 2, halfHourFee: 1, hourFee: 1 }
        : fixture.difficulty;
      return { ok: true, status: 200, json: async () => payload, text: async () => String(fixture.height) };
    }));
    const onSnapshot = vi.fn();
    const warn = vi.fn();
    const ingestor = new OnchainIngestor({ onchainBaseUrl: "https://example.invalid/api" } as AppConfig,
      { warn } as unknown as Logger, onSnapshot);
    return { fixture, ingestor, onSnapshot, warn };
  }

  it.each([-75, -3.25, 0, 4.5, 300])("publishes the estimated percentage change %s, not epoch progress", async (change) => {
    const { ingestor, onSnapshot, warn } = setup({ difficultyChange: change, progressPercent: 75 });
    await ingestor.start();
    expect(onSnapshot).toHaveBeenCalledOnce();
    expect(onSnapshot.mock.calls[0]![0]).toMatchObject({ difficultyAdjustment: change, mempoolTxCount: 100 });
    expect(warn).not.toHaveBeenCalled();
    ingestor.stop();
  });

  it.each([{}, null, [], { difficultyChange: null }, { difficultyChange: "3" },
    { difficultyChange: NaN }, { difficultyChange: Infinity }, { difficultyChange: -Infinity },
    { difficultyChange: -75.01 }, { difficultyChange: 300.01 }])("rejects malformed difficulty data %j", async (difficulty) => {
    const { ingestor, onSnapshot, warn } = setup(difficulty);
    await ingestor.start();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0].error.message).toMatch(/\/v1\/difficulty-adjustment.*difficultyChange/);
    ingestor.stop();
  });

  it("keeps cadence based on the last accepted poll when a difficulty payload is rejected", async () => {
    const { ingestor, fixture, onSnapshot } = setup({ difficultyChange: -3, progressPercent: 75 });
    await ingestor.start();
    fixture.height = 900010;
    fixture.difficulty = {};
    await vi.advanceTimersByTimeAsync(300_000);
    expect(onSnapshot).toHaveBeenCalledOnce();
    fixture.height = 900002;
    fixture.difficulty = { difficultyChange: 0, progressPercent: 90 };
    await vi.advanceTimersByTimeAsync(300_000);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
    expect(onSnapshot.mock.calls[1]![0]).toMatchObject({ difficultyAdjustment: 0, blockCadenceSeconds: 300 });
    ingestor.stop();
  });
});
