import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("RSS feed configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEWS_FEEDS", undefined);
    vi.stubEnv("MACRO_FEEDS", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps feeds optional", async () => {
    const { config } = await import("./config.js");
    expect(config.feeds).toEqual({ news: [], macro: [] });
  });

  it("trims entries and ignores empty comma-separated fields", async () => {
    vi.stubEnv("NEWS_FEEDS", " https://news.example/rss?q=btc , , http://legacy.example/feed, ");
    vi.stubEnv("MACRO_FEEDS", " https://macro.example/feed.xml ");
    const { config } = await import("./config.js");
    expect(config.feeds).toEqual({
      news: ["https://news.example/rss?q=btc", "http://legacy.example/feed"],
      macro: ["https://macro.example/feed.xml"]
    });
  });

  it.each(["NEWS_FEEDS", "MACRO_FEEDS"])("accepts an empty %s list", async (variable) => {
    vi.stubEnv(variable, " , , ");
    const { config } = await import("./config.js");
    expect(config.feeds).toEqual({ news: [], macro: [] });
  });

  it.each(["NEWS_FEEDS", "MACRO_FEEDS"])("rejects a bad entry in %s", async (variable) => {
    vi.stubEnv(variable, "https://valid.example/rss,missing-scheme.example/rss");
    await expect(import("./config.js")).rejects.toThrow(variable);
  });

  it.each([
    ["NEWS_FEEDS", "ftp://feeds.example/rss"],
    ["NEWS_FEEDS", "file:///tmp/feed.xml"],
    ["MACRO_FEEDS", "mailto:feeds@example.com"],
    ["MACRO_FEEDS", "wss://feeds.example/rss"]
  ])("rejects unsupported transport in %s", async (variable, url) => {
    vi.stubEnv(variable, url);
    await expect(import("./config.js")).rejects.toThrow(variable);
    await expect(import("./config.js")).rejects.toThrow("http: or https:");
  });
});
