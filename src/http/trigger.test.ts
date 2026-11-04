import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeState } from "../services/runtimeState.js";
import { createHttpServer } from "./server.js";
const captured = vi.hoisted(() => ({ apps: [] as FastifyInstance[] }));
vi.mock("fastify", async (original) => {
  const { default: Fastify } = await original<typeof import("fastify")>();
  return { default: () => {
    const app = Fastify({ logger: false }); captured.apps.push(app); return app;
  } };
});
afterEach(async () => { await Promise.all(captured.apps.splice(0).map((app) => app.close())); });
describe("POST /trigger", () => {
  it.each([
    ["completed", 200, true], ["busy", 409, false], ["no_market", 503, false], ["failed", 500, false]
  ] as const)("returns %s explicitly", async (status, code, ok) => {
    await createHttpServer(new RuntimeState(10000), 0, async () => ({ status }));
    const response = await captured.apps.at(-1)!.inject({ method: "POST", url: "/trigger" });
    expect(response.statusCode).toBe(code);
    expect(response.json()).toEqual({ ok, status });
  });
  it("reports unavailable when no evaluator exists", async () => {
    await createHttpServer(new RuntimeState(10000), 0);
    const response = await captured.apps.at(-1)!.inject({ method: "POST", url: "/trigger" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, status: "unavailable" });
  });
  it("does not expose internal error details", async () => {
    await createHttpServer(new RuntimeState(10000), 0, async () => { throw new Error("sensitive detail"); });
    const response = await captured.apps.at(-1)!.inject({ method: "POST", url: "/trigger" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ ok: false, status: "failed" });
    expect(response.body).not.toContain("sensitive");
  });
});
