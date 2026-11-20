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
        return new Response("upstream failed\n".repeat(100_000), { status: 502 });
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
      expect(logger.warn.mock.calls[0]?.[0].error.message.length).toBe("Failed to fetch tip height: HTTP 502".length);
      expect(logger.warn.mock.calls[0]?.[0].error.message).toBe("Failed to fetch tip height: HTTP 502");
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

  it("rejects zero as an invalid tip height", async () => {
    const ingestor = new OnchainIngestor(config, { warn: vi.fn() } as never, vi.fn());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("0", { status: 200 })));

    await expect(
      (ingestor as never as { fetchTipHeight: () => Promise<number> }).fetchTipHeight()
    ).rejects.toThrow("Failed to fetch tip height: invalid response");
  });

  it("discards oversized error bodies without reading them", async () => {
    const ingestor = new OnchainIngestor(config, { warn: vi.fn() } as never, vi.fn());
    const response = new Response("upstream failed\n".repeat(100_000), { status: 502 });
    const readBody = vi.spyOn(response, "text");
    const cancelBody = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const failure = await (ingestor as never as { fetchTipHeight: () => Promise<number> }).fetchTipHeight()
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message.length).toBe("Failed to fetch tip height: HTTP 502".length);
    expect((failure as Error).message).toBe("Failed to fetch tip height: HTTP 502");

    expect(readBody).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });

  it("rejects promptly when an error body and its cancellation never settle", async () => {
    const ingestor = new OnchainIngestor(config, { warn: vi.fn() } as never, vi.fn());
    const readBody = vi.fn(() => new Promise<string>(() => undefined));
    const cancelBody = vi.fn(() => new Promise<void>(() => undefined));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 503, text: readBody, body: { cancel: cancelBody }
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = await Promise.race([
        (ingestor as never as { fetchTipHeight: () => Promise<number> }).fetchTipHeight()
          .then(() => "unexpected success", (error: Error) => error.message),
        new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting for body"), 100); })
      ]);
      expect(result).toBe("Failed to fetch tip height: HTTP 503");
      expect(readBody).not.toHaveBeenCalled();
      expect(cancelBody).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(timer);
    }
  });

  it("preserves the HTTP failure when unused-body cancellation rejects", async () => {
    const ingestor = new OnchainIngestor(config, { warn: vi.fn() } as never, vi.fn());
    const readBody = vi.fn().mockRejectedValue(new Error("failed to read body"));
    const cancelBody = vi.fn().mockRejectedValue(new Error("failed to cancel body"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 429, text: readBody, body: { cancel: cancelBody }
    }));

    await expect(
      (ingestor as never as { fetchTipHeight: () => Promise<number> }).fetchTipHeight()
    ).rejects.toThrow("Failed to fetch tip height: HTTP 429");

    expect(readBody).not.toHaveBeenCalled();
    expect(cancelBody).toHaveBeenCalledTimes(1);
  });
});
