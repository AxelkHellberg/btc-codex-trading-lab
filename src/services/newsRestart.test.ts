import type { Logger } from "pino";
import Parser from "rss-parser";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.js";
import { NewsIngestor, type NewsAcknowledgementStore } from "./newsIngestor.js";
const config = { symbol: "BTCUSDT", tradingMode: "paper", feeds: { news: ["https://offline.invalid/rss"], macro: [] } } as unknown as AppConfig;
const item = (suffix = "") => ({ title: `Bitcoin ETF approval${suffix}`, link: `https://offline.invalid/${suffix}` });
const poll = (x: NewsIngestor) => (x as unknown as { poll(): Promise<void> }).poll();
const logger = { warn: vi.fn() } as unknown as Logger;
const checkpoint = () => {
  let ids: string[] = [];
  return { loadAcknowledgedNews: vi.fn(async () => [...ids]),
    saveAcknowledgedNews: vi.fn(async (_scope: string, next: string[]) => { ids = [...next]; }) };
};
afterEach(() => vi.restoreAllMocks());
describe("persistent news acknowledgement", () => {
  it("suppresses acknowledged headlines after restart and delivers new headlines", async () => {
    const feed = vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({ title: "Fixture", items: [item()] });
    const store = checkpoint(); const first = vi.fn();
    await poll(new NewsIngestor(config, logger, first, store));
    const second = vi.fn(); const restarted = new NewsIngestor(config, logger, second, store);
    await poll(restarted); expect(second).not.toHaveBeenCalled();
    feed.mockResolvedValue({ title: "Fixture", items: [item(), item("new")] });
    await poll(restarted); expect(second).toHaveBeenCalledOnce();
    expect(second.mock.calls[0]![0]).toHaveLength(1);
    expect(first).toHaveBeenCalledOnce();
    expect(store.loadAcknowledgedNews).toHaveBeenCalledWith("BTCUSDT:paper");
  });
  it("does not persist failed downstream delivery across restart", async () => {
    vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({ title: "Fixture", items: [item()] });
    const store = checkpoint();
    await expect(poll(new NewsIngestor(config, logger, vi.fn().mockRejectedValue(new Error("sink")), store))).rejects.toThrow("sink");
    expect(store.saveAcknowledgedNews).not.toHaveBeenCalled();
    const delivered = vi.fn(); await poll(new NewsIngestor(config, logger, delivered, store));
    expect(delivered).toHaveBeenCalledOnce();
  });
  it("blocks feed delivery when the checkpoint cannot be loaded", async () => {
    const feed = vi.spyOn(Parser.prototype, "parseURL"); const delivered = vi.fn();
    const store = checkpoint(); store.loadAcknowledgedNews.mockRejectedValueOnce(new Error("database down"));
    await expect(poll(new NewsIngestor(config, logger, delivered, store))).rejects.toThrow("database down");
    expect(feed).not.toHaveBeenCalled(); expect(delivered).not.toHaveBeenCalled();
  });
  it("retries after a checkpoint save fails rather than silently acknowledging", async () => {
    vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({ title: "Fixture", items: [item()] });
    const store = checkpoint(); store.saveAcknowledgedNews.mockRejectedValueOnce(new Error("write failed"));
    const delivered = vi.fn(); const x = new NewsIngestor(config, logger, delivered, store);
    await expect(poll(x)).rejects.toThrow("write failed"); await poll(x);
    expect(delivered).toHaveBeenCalledTimes(2);
  });
  it("coalesces overlapping polls while loading persisted IDs", async () => {
    vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({ title: "Fixture", items: [item()] });
    const store = checkpoint(); const delivered = vi.fn(); const x = new NewsIngestor(config, logger, delivered, store);
    await Promise.all([poll(x), poll(x)]);
    expect(store.loadAcknowledgedNews).toHaveBeenCalledOnce(); expect(delivered).toHaveBeenCalledOnce();
  });
  it("retains a bounded window of the most recently acknowledged IDs", async () => {
    vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({ title: "Fixture", items: [item()] });
    const old = Array.from({ length: 10_000 }, (_, i) => i.toString(16).padStart(40, "0"));
    const store: NewsAcknowledgementStore = { loadAcknowledgedNews: async () => old, saveAcknowledgedNews: vi.fn() };
    await poll(new NewsIngestor(config, logger, vi.fn(), store));
    const ids = vi.mocked(store.saveAcknowledgedNews).mock.calls[0]![1];
    expect(ids).toHaveLength(10_000); expect(ids).not.toContain(old[0]); expect(ids).toContain(old[9999]);
  });
  it("rejects corrupt checkpoints", async () => {
    const store = checkpoint(); store.loadAcknowledgedNews.mockResolvedValueOnce(["invalid"]);
    await expect(poll(new NewsIngestor(config, logger, vi.fn(), store))).rejects.toThrow("Invalid persisted");
  });
});
