import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

const loadConfig = async () => {
  vi.resetModules();
  return import("./config.js");
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("config", () => {
  it("defaults CODEX_USE_CLI_FALLBACK to true when unset", async () => {
    delete process.env.CODEX_USE_CLI_FALLBACK;

    const { config } = await loadConfig();

    expect(config.codex.useCliFallback).toBe(true);
  });

  it("accepts common false-like values for CODEX_USE_CLI_FALLBACK", async () => {
    for (const value of ["false", "FALSE", "0", "no", "off"]) {
      process.env = {
        ...ORIGINAL_ENV,
        CODEX_USE_CLI_FALLBACK: value
      };

      const { config } = await loadConfig();
      expect(config.codex.useCliFallback, `expected ${value} to disable fallback`).toBe(false);
    }
  });

  it("trims and splits configured feed lists", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      NEWS_FEEDS: " https://news.example/a.xml , ,https://news.example/b.xml ",
      MACRO_FEEDS: " https://macro.example/feed "
    };

    const { config } = await loadConfig();

    expect(config.feeds.news).toEqual([
      "https://news.example/a.xml",
      "https://news.example/b.xml"
    ]);
    expect(config.feeds.macro).toEqual(["https://macro.example/feed"]);
  });
});
