import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "pino";
import { config } from "../config.js";
import { NewsIngestor } from "./newsIngestor.js";

const rss = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock("rss-parser", () => ({ default: class { parseURL = rss.parse; } }));

const article = (id: string) => ({ title: `Bitcoin ${id}`, link: `https://news.invalid/${id}`, isoDate: "2020-01-01T00:00:00Z" });
const response = (ids: string[]) => ({ title: "Fixture", items: ids.map(article) });
type Inspect = { seen: Set<string>; poll: () => Promise<void> };
const logger = { warn: vi.fn() } as unknown as Logger;
const settings = { ...config, feeds: { news: ["https://news.invalid/feed"], macro: [] } };

afterEach(() => { rss.parse.mockReset(); vi.restoreAllMocks(); });

describe("bounded RSS duplicate suppression", () => {
  it("bounds lifetime memory, evicts old IDs, and still suppresses recent repeats", async () => {
    const delivered = vi.fn();
    const ingestor = new NewsIngestor(settings, logger, delivered);
    const inspect = ingestor as unknown as Inspect;
    rss.parse.mockResolvedValue(response(["oldest"]));
    try { await ingestor.start(); } finally { ingestor.stop(); }
    await inspect.poll();
    expect(delivered).toHaveBeenCalledTimes(1);
    for (let batch = 0; batch < 1_000; batch += 1) {
      rss.parse.mockResolvedValue(response(Array.from({ length: 10 }, (_, i) => `${batch}-${i}`)));
      await inspect.poll();
      expect(inspect.seen.size).toBeLessThanOrEqual(10_000);
    }
    delivered.mockClear();
    rss.parse.mockResolvedValue(response(["999-9", "oldest"]));
    await inspect.poll();
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered.mock.calls[0]![0].map((event: { title: string }) => event.title)).toEqual(["Bitcoin oldest"]);
    expect(inspect.seen.size).toBe(10_000);
    await inspect.poll();
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it("does not repeat an item within one poll when that batch exceeds the retained window", async () => {
    const feeds = Array.from({ length: 1_002 }, (_, i) => `https://news.invalid/${i}`);
    rss.parse.mockImplementation(async (url: string) => {
      const index = Number(url.split("/").at(-1));
      return index === 1_001 ? response(["0-0"]) : response(Array.from({ length: 10 }, (_, i) => `${index}-${i}`));
    });
    const delivered = vi.fn();
    const ingestor = new NewsIngestor({ ...settings, feeds: { news: feeds, macro: [] } }, logger, delivered);
    try { await ingestor.start(); } finally { ingestor.stop(); }
    const events = delivered.mock.calls[0]![0] as Array<{ id: string }>;
    expect(events).toHaveLength(10_010);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect((ingestor as unknown as Inspect).seen.size).toBe(10_000);
  });

  it("documents process-local retention through a fresh-instance restart control", async () => {
    rss.parse.mockResolvedValue(response(["same"]));
    const delivered = vi.fn();
    for (let i = 0; i < 2; i += 1) {
      const ingestor = new NewsIngestor(settings, logger, delivered);
      try { await ingestor.start(); } finally { ingestor.stop(); }
    }
    expect(delivered).toHaveBeenCalledTimes(2);
  });
});
