import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("exchange endpoint configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("BINANCE_FUTURES_BASE_URL", undefined);
    vi.stubEnv("BINANCE_FUTURES_WS_URL", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("keeps secure defaults", async () => {
    const { config } = await import("./config.js");
    expect(config.binance.restBaseUrl).toBe("https://fapi.binance.com");
    expect(config.binance.wsBaseUrl).toBe("wss://fstream.binance.com/stream");
  });

  it("accepts secure testnet or proxy overrides without rewriting them", async () => {
    vi.stubEnv("BINANCE_FUTURES_BASE_URL", "https://exchange.example:8443/api");
    vi.stubEnv("BINANCE_FUTURES_WS_URL", "wss://stream.example:9443/stream");
    const { config } = await import("./config.js");
    expect(config.binance.restBaseUrl).toBe("https://exchange.example:8443/api");
    expect(config.binance.wsBaseUrl).toBe("wss://stream.example:9443/stream");
  });

  it.each([
    ["BINANCE_FUTURES_BASE_URL", "http://exchange.example", "https:"],
    ["BINANCE_FUTURES_BASE_URL", "wss://exchange.example", "https:"],
    ["BINANCE_FUTURES_BASE_URL", "ftp://exchange.example", "https:"],
    ["BINANCE_FUTURES_WS_URL", "ws://stream.example/stream", "wss:"],
    ["BINANCE_FUTURES_WS_URL", "http://stream.example/stream", "wss:"],
    ["BINANCE_FUTURES_WS_URL", "https://stream.example/stream", "wss:"]
  ])("rejects %s=%s with the expected scheme", async (variable, value, scheme) => {
    vi.stubEnv(variable, value);
    await expect(import("./config.js")).rejects.toThrow(variable);
    await expect(import("./config.js")).rejects.toThrow(scheme);
  });

  it.each(["BINANCE_FUTURES_BASE_URL", "BINANCE_FUTURES_WS_URL"])(
    "rejects a malformed %s", async (variable) => {
      vi.stubEnv(variable, "not-a-url");
      await expect(import("./config.js")).rejects.toThrow(variable);
    }
  );
});
