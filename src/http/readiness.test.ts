import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer, type HttpServer } from "./server.js";
import { RuntimeState } from "../services/runtimeState.js";
import { createReadinessCheck } from "../services/readiness.js";
import type { MarketSnapshot } from "../domain/types.js";

const servers: HttpServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop())); vi.useRealTimers(); });
const setup = async () => {
  let running = true;
  let market: Pick<MarketSnapshot, "timestamp"> | null = { timestamp: Date.now() };
  const postgres = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const redis = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const readiness = createReadinessCheck({ isRunning: () => running,
    getMarket: () => market as MarketSnapshot | null, postgres, redis });
  const server = await createHttpServer(new RuntimeState(1_000), 0, undefined, readiness);
  servers.push(server);
  return { server, postgres, redis, setRunning: (value: boolean) => { running = value; },
    setMarket: (value: typeof market) => { market = value; } };
};

describe("runtime readiness HTTP contract", () => {
  it("keeps liveness available and returns readiness for healthy dependencies", async () => {
    const x = await setup();
    expect((await x.server.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    const ready = await x.server.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ready: true, components: { postgres: "up", redis: "up", startup: "up", market: "up" } });
  });
  it.each(["postgres", "redis"] as const)("returns 503 on %s failure without exposing error contents", async key => {
    const x = await setup(); x[key].mockRejectedValue(new Error("private://password@host"));
    const ready = await x.server.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(503); expect(ready.json().components[key]).toBe("down");
    expect(ready.body).not.toContain("password");
    expect((await x.server.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
  });
  it("fails before startup and during shutdown, then recovers when running", async () => {
    const x = await setup(); x.setRunning(false);
    expect((await x.server.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
    x.setRunning(true); expect((await x.server.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    x.setRunning(false); expect((await x.server.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
  });
  it.each([null, -90_001, 60_000, NaN])("rejects missing, stale, future or invalid market time %s", async offset => {
    const x = await setup(); x.setMarket(offset === null ? null : { timestamp: Date.now() + offset });
    expect((await x.server.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
  });
  it("fails closed when no readiness provider is configured", async () => {
    const server = await createHttpServer(new RuntimeState(1_000), 0); servers.push(server);
    expect((await server.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(503);
  });
  it("does not expose provider exceptions", async () => {
    const server = await createHttpServer(new RuntimeState(1_000), 0, undefined, async () => { throw new Error("private probe"); });
    servers.push(server); const response = await server.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain("private probe");
  });
  it("bounds stalled probes, shares pending commands across requests, and recovers", async () => {
    const x = await setup(); let finish!: () => void;
    x.postgres.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const first = x.server.inject({ method: "GET", url: "/readyz" }).then(response => response);
    const parallel = x.server.inject({ method: "GET", url: "/readyz" }).then(response => response);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await first).statusCode).toBe(503); expect((await parallel).json().components.postgres).toBe("timeout");
    expect(x.postgres).toHaveBeenCalledOnce();
    const another = x.server.inject({ method: "GET", url: "/readyz" }).then(response => response);
    await vi.advanceTimersByTimeAsync(1_000); expect((await another).statusCode).toBe(503);
    expect(x.postgres).toHaveBeenCalledOnce();
    finish(); await vi.advanceTimersByTimeAsync(0); x.postgres.mockResolvedValue(undefined);
    expect((await x.server.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });
  it("rechecks lifecycle after awaited probes so shutdown cannot report ready", async () => {
    const x = await setup(); let finish!: () => void;
    x.postgres.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const response = x.server.inject({ method: "GET", url: "/readyz" }).then(value => value);
    await vi.waitFor(() => expect(x.postgres).toHaveBeenCalledOnce()); x.setRunning(false); finish();
    expect((await response).statusCode).toBe(503);
  });
});
