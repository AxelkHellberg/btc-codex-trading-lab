import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../config.js", () => ({ config: { postgresUrl: "fixture", redisUrl: "fixture", port: 1, symbol: "BTCUSDT", tradingMode: "paper", binance: { restBaseUrl: "https://fixture.invalid" }, telegram: {} } }));
vi.mock("../logger.js", () => ({ logger: { info: mocks.info, error: mocks.error } }));
vi.mock("pg", () => ({ Client: class { async connect() {} async query() {} async end() {} } }));
vi.mock("ioredis", () => ({ Redis: class { on() {} async connect() {} async ping() { return "PONG"; } async quit() {} } }));
afterEach(() => vi.unstubAllGlobals());

it("doctor checks the same installed CLI without global PATH or npx resolution", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => child.emit("close", 0));
    return child;
  });
  await import("./doctor.js");
  await vi.waitFor(() => expect(mocks.info).toHaveBeenCalled());
  expect(mocks.error).not.toHaveBeenCalled();
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(process.execPath,
    [createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"), "login", "status"],
    { env: process.env });
});
