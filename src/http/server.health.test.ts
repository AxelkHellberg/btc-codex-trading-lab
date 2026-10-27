import { createServer } from "node:net";

import { expect, it } from "vitest";

import { RuntimeState } from "../services/runtimeState.js";
import { createHttpServer } from "./server.js";

it("identifies the serving process in the health payload", async () => {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await createHttpServer(new RuntimeState(10_000), port);
  try {
    await server.start();
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(response.ok).toBe(true);
    const health = await response.json();
    expect(health).toMatchObject({ ok: true, pid: process.pid });
    expect(Number.isFinite(health.ts)).toBe(true);
  } finally {
    await server.stop();
  }
});
