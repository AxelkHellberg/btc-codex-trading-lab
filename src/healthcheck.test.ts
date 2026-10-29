import { spawn } from "node:child_process";
import { createServer, type Server, type RequestListener } from "node:http";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
});

async function serve(handler: RequestListener): Promise<number> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return address.port;
}

async function probe(port: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/healthcheck.mjs", import.meta.url))], {
      env: { ...process.env, APP_PORT: port },
      stdio: "ignore",
      timeout: 4500
    });
    child.on("error", reject);
    child.on("close", (code, signal) => signal ? reject(new Error(`Probe exceeded deadline: ${signal}`)) : resolve(code));
  });
}

describe("container health probe", () => {
  it("accepts the health endpoint on a configured internal port", async () => {
    const port = await serve((request, response) => {
      expect(request.url).toBe("/healthz");
      response.end(JSON.stringify({ ok: true, ts: Date.now() }));
    });
    expect(await probe(String(port))).toBe(0);
  });

  it.each([
    [503, '{"ok":true}'],
    [200, '{"ok":false}'],
    [200, '{"ok":"true"}'],
    [200, "not json"]
  ])("rejects unhealthy HTTP %s / %s", async (status, body) => {
    const port = await serve((_request, response) => {
      response.writeHead(status);
      response.end(body);
    });
    expect(await probe(String(port))).toBe(1);
  });

  it("rejects redirects instead of probing a different endpoint", async () => {
    const port = await serve((_request, response) => {
      response.writeHead(302, { location: "/elsewhere" });
      response.end();
    });
    expect(await probe(String(port))).toBe(1);
  });

  it("fails when no service is listening", async () => {
    const port = await serve((_request, response) => response.end());
    await new Promise<void>((resolve) => servers[0]!.close(() => resolve()));
    expect(await probe(String(port))).toBe(1);
  });

  it.each(["0", "65536", "invalid"])("rejects invalid APP_PORT=%s", async (port) => {
    expect(await probe(port)).toBe(1);
  });

  it.each([false, true])("bounds a stalled response, headers already sent=%s", async (headersSent) => {
    const port = await serve((_request, response) => {
      if (headersSent) {
        response.writeHead(200);
        response.write('{"ok":');
      }
    });
    expect(await probe(String(port))).toBe(1);
  }, 5000);
});
