import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("POSTGRES_URL", undefined);
  vi.stubEnv("REDIS_URL", undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe("storage connection URL configuration", () => {
  it("retains the default connection strings", async () => {
    const { config } = await import("./config.js");
    expect(config.postgresUrl).toBe("postgres://postgres:postgres@localhost:5432/trader");
    expect(config.redisUrl).toBe("redis://localhost:6379");
  });

  it.each([
    ["POSTGRES_URL", "postgres://user:p%40ss@localhost:5432/research?sslmode=require", "postgresUrl"],
    ["POSTGRES_URL", "postgresql://user:password@[::1]:5432/research?application_name=test", "postgresUrl"],
    ["POSTGRES_URL", "postgresql:///research?host=/var/run/postgresql", "postgresUrl"],
    ["REDIS_URL", "redis://user:p%40ss@localhost:6379/2", "redisUrl"],
    ["REDIS_URL", "rediss://user:password@[::1]:6380/0?keepAlive=1000", "redisUrl"]
  ] as const)("preserves valid %s options: %s", async (key, value, field) => {
    vi.stubEnv(key, value);
    const { config } = await import("./config.js");
    expect(config[field]).toBe(value);
  });

  it.each([
    ["POSTGRES_URL", "not-a-url"],
    ["POSTGRES_URL", ""],
    ["POSTGRES_URL", "redis://localhost:6379"],
    ["POSTGRES_URL", "https://localhost/database"],
    ["POSTGRES_URL", "postgres:database"],
    ["POSTGRES_URL", "postgres://[broken/database"],
    ["REDIS_URL", "not-a-url"],
    ["REDIS_URL", ""],
    ["REDIS_URL", "postgres://localhost/database"],
    ["REDIS_URL", "https://localhost/0"],
    ["REDIS_URL", "redis:localhost"],
    ["REDIS_URL", "rediss://[broken/0"]
  ])("rejects invalid %s without constructing a client: %s", async (key, value) => {
    vi.stubEnv(key, value);
    await expect(import("./config.js")).rejects.toThrow(key);
  });
});
