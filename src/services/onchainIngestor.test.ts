import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import { OnchainIngestor } from "./onchainIngestor.js";

describe("OnchainIngestor", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("preserves the previous cadence baseline when tip-height refresh fails", async () => {
    const onSnapshot = vi.fn();
    const logger = { warn: vi.fn() };
    const ingestor = new OnchainIngestor(config, logger as never, onSnapshot);
    const fetchMock = vi.fn<(input: string | URL | Request) => Promise<Response>>();

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/mempool")) {
        return new Response(JSON.stringify({ count: 12 }), { status: 200 });
      }
      if (url.endsWith("/v1/fees/recommended")) {
        return new Response(
          JSON.stringify({ fastestFee: 20, halfHourFee: 15, hourFee: 10 }),
          { status: 200 }
        );
      }
      if (url.endsWith("/v1/difficulty-adjustment")) {
        return new Response(
          JSON.stringify({
            progressPercent: 42,
            remainingBlocks: 10,
            nextRetargetHeight: 900_000,
            previousRetarget: 1
          }),
          { status: 200 }
        );
      }

      const tipHeightResponse = fetchMock.mock.calls.filter(([value]) =>
        String(value).endsWith("/blocks/tip/height")
      ).length;

      if (tipHeightResponse === 1) {
        return new Response("100", { status: 200 });
      }
      if (tipHeightResponse === 2) {
        return new Response("bad gateway", { status: 502 });
      }

      return new Response("101", { status: 200 });
    });

    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T09:00:00.000Z"));
      await (ingestor as never as { poll: () => Promise<void> }).poll();

      vi.setSystemTime(new Date("2026-08-04T09:01:00.000Z"));
      await (ingestor as never as { poll: () => Promise<void> }).poll();

      vi.setSystemTime(new Date("2026-08-04T09:02:00.000Z"));
      await (ingestor as never as { poll: () => Promise<void> }).poll();

      expect(onSnapshot).toHaveBeenCalledTimes(2);
      expect(onSnapshot.mock.calls[0]?.[0].tipHeight).toBe(100);
      expect(onSnapshot.mock.calls[1]?.[0].tipHeight).toBe(101);
      expect(onSnapshot.mock.calls[1]?.[0].blockCadenceSeconds).toBe(120);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect((ingestor as never as { lastHeight: number | null }).lastHeight).toBe(101);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("rejects blank tip-height responses without poisoning cadence state", async () => {
    const onSnapshot = vi.fn();
    const logger = { warn: vi.fn() };
    const ingestor = new OnchainIngestor(config, logger as never, onSnapshot);
    const fetchMock = vi.fn<(input: string | URL | Request) => Promise<Response>>();

    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/mempool")) {
        return new Response(JSON.stringify({ count: 12 }), { status: 200 });
      }
      if (url.endsWith("/v1/fees/recommended")) {
        return new Response(
          JSON.stringify({ fastestFee: 20, halfHourFee: 15, hourFee: 10 }),
          { status: 200 }
        );
      }
      if (url.endsWith("/v1/difficulty-adjustment")) {
        return new Response(
          JSON.stringify({
            progressPercent: 42,
            remainingBlocks: 10,
            nextRetargetHeight: 900_000,
            previousRetarget: 1
          }),
          { status: 200 }
        );
      }

      const tipHeightResponse = fetchMock.mock.calls.filter(([value]) =>
        String(value).endsWith("/blocks/tip/height")
      ).length;

      if (tipHeightResponse === 1) {
        return new Response("100", { status: 200 });
      }
      if (tipHeightResponse === 2) {
        return new Response("   ", { status: 200 });
      }

      return new Response("101", { status: 200 });
    });

    vi.stubGlobal("fetch", fetchMock);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-04T09:00:00.000Z"));
      await (ingestor as never as { poll: () => Promise<void> }).poll();

      vi.setSystemTime(new Date("2026-08-04T09:01:00.000Z"));
      await (ingestor as never as { poll: () => Promise<void> }).poll();

      vi.setSystemTime(new Date("2026-08-04T09:02:00.000Z"));
      await (ingestor as never as { poll: () => Promise<void> }).poll();

      expect(onSnapshot).toHaveBeenCalledTimes(2);
      expect(onSnapshot.mock.calls[0]?.[0].tipHeight).toBe(100);
      expect(onSnapshot.mock.calls[1]?.[0].tipHeight).toBe(101);
      expect(onSnapshot.mock.calls[1]?.[0].blockCadenceSeconds).toBe(120);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect((ingestor as never as { lastHeight: number | null }).lastHeight).toBe(101);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
