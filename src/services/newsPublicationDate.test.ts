import type { Logger } from "pino";
import Parser from "rss-parser";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import type { NewsEvent } from "../domain/types.js";
import { NewsIngestor } from "./newsIngestor.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("news publication dates", () => {
  it.each([undefined, "", "not a date", "2026-99-99T00:00:00Z"])(
    "uses ingestion time for an absent or invalid date (%s)", async (isoDate) => {
      vi.useFakeTimers();
      const now = Date.parse("2026-10-22T15:00:00Z");
      vi.setSystemTime(now);
      vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({
        title: "Fixture feed", items: [{ title: "Bitcoin update", isoDate }]
      });
      const onEvents = vi.fn<(events: NewsEvent[]) => void>();
      const ingestor = new NewsIngestor(
        { feeds: { news: ["https://example.test/rss"], macro: [] } } as AppConfig,
        { warn: vi.fn() } as unknown as Logger, onEvents
      );

      try {
        await ingestor.start();
        expect(onEvents).toHaveBeenCalledOnce();
        const event = onEvents.mock.calls[0]![0][0]!;
        expect(event.publishedAt).toBe(now);
        expect(JSON.parse(JSON.stringify(event)).publishedAt).toBe(now);
      } finally {
        ingestor.stop();
      }
    }
  );

  it.each(["2026-10-21T14:30:00Z", "1970-01-01T00:00:00Z", "1969-12-31T23:59:59Z"])(
    "preserves a valid publication date (%s)", async (isoDate) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-22T15:00:00Z"));
      vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({
        title: "Fixture feed", items: [{ title: "Bitcoin update", isoDate }]
      });
      const onEvents = vi.fn<(events: NewsEvent[]) => void>();
      const ingestor = new NewsIngestor(
        { feeds: { news: [], macro: ["https://example.test/rss"] } } as AppConfig,
        { warn: vi.fn() } as unknown as Logger, onEvents
      );

      try {
        await ingestor.start();
        expect(onEvents.mock.calls[0]![0][0]!.publishedAt).toBe(Date.parse(isoDate));
      } finally {
        ingestor.stop();
      }
    }
  );
});
