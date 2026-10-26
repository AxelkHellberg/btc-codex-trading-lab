import type { Logger } from "pino";
import Parser from "rss-parser";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.js";
import { NewsIngestor } from "./newsIngestor.js";

const item = { title: "Bitcoin ETF approval", link: "https://example.test/news", isoDate: "2026-10-26T08:00:00Z" };
const config = { feeds: { news: ["https://example.test/feed"], macro: [] } } as unknown as AppConfig;
const logger = { warn: vi.fn() } as unknown as Logger;
const poll = (ingestor: NewsIngestor) => (ingestor as unknown as { poll(): Promise<void> }).poll();

afterEach(() => vi.restoreAllMocks());

describe("news delivery acknowledgement", () => {
  it("retries the identical batch after an asynchronous downstream failure", async () => {
    vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({ title: "Fixture", items: [item] });
    const onEvents = vi.fn().mockRejectedValueOnce(new Error("storage unavailable")).mockResolvedValue(undefined);
    const ingestor = new NewsIngestor(config, logger, onEvents);

    await expect(poll(ingestor)).rejects.toThrow("storage unavailable");
    await poll(ingestor);
    expect(onEvents).toHaveBeenCalledTimes(2);
    expect(onEvents.mock.calls[1]?.[0]).toEqual(onEvents.mock.calls[0]?.[0]);
    await poll(ingestor);
    expect(onEvents).toHaveBeenCalledTimes(2);
  });

  it("also retries after a synchronous callback throws", async () => {
    vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({ title: "Fixture", items: [item] });
    const onEvents = vi.fn().mockImplementationOnce(() => { throw new Error("sink failed"); });
    const ingestor = new NewsIngestor(config, logger, onEvents);
    await expect(poll(ingestor)).rejects.toThrow("sink failed");
    await poll(ingestor);
    expect(onEvents).toHaveBeenCalledTimes(2);
  });

  it("deduplicates within and across feeds while keeping failed deliveries retryable", async () => {
    vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({ title: "Fixture", items: [item, item] });
    const onEvents = vi.fn().mockRejectedValueOnce(new Error("sink failed")).mockResolvedValue(undefined);
    const ingestor = new NewsIngestor({ feeds: { news: ["https://a.test/feed"], macro: ["https://b.test/feed"] } } as unknown as AppConfig, logger, onEvents);
    await expect(poll(ingestor)).rejects.toThrow("sink failed");
    await poll(ingestor);
    expect(onEvents).toHaveBeenCalledTimes(2);
    expect(onEvents.mock.calls[0]?.[0]).toHaveLength(1);
    expect(onEvents.mock.calls[1]?.[0]).toHaveLength(1);
  });

  it("acknowledges only after a deferred callback finishes", async () => {
    vi.spyOn(Parser.prototype, "parseURL").mockResolvedValue({ title: "Fixture", items: [item] });
    let reject!: (error: Error) => void;
    const onEvents = vi.fn().mockImplementationOnce(() => new Promise<void>((_, no) => { reject = no; }));
    const ingestor = new NewsIngestor(config, logger, onEvents);
    const delivery = poll(ingestor);
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce());
    reject(new Error("late failure"));
    await expect(delivery).rejects.toThrow("late failure");
    await poll(ingestor);
    expect(onEvents).toHaveBeenCalledTimes(2);
  });
});
