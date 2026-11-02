import { afterEach, describe, expect, it } from "vitest";
import { RuntimeState } from "../services/runtimeState.js";
import { createHttpServer } from "./server.js";

const servers: Awaited<ReturnType<typeof createHttpServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); });

describe("configured trading mode", () => {
  it.each(["paper", "live"] as const)("reports %s mode through status and the dashboard without starting services", async (mode) => {
    const server = await createHttpServer(new RuntimeState(10_000), 0, mode);
    servers.push(server);
    const status = await server.inject({ method: "GET", url: "/status" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ tradingMode: mode, position: { side: "flat" } });
    const dashboard = await server.inject({ method: "GET", url: "/" });
    expect(dashboard.statusCode).toBe(200);
    if (mode === "live") {
      expect(dashboard.body).toContain('id="tradingMode" class="negative">LIVE trading: real orders enabled</strong>');
      expect(dashboard.body).not.toContain("Paper mode dashboard");
      expect(dashboard.body).not.toContain("Paper trading: simulated orders");
    } else {
      expect(dashboard.body).toContain('id="tradingMode" class="positive">Paper trading: simulated orders</strong>');
      expect(dashboard.body).not.toContain("LIVE trading: real orders enabled");
    }
  });
});
