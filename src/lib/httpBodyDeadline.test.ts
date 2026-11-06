import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, RequestTimeoutError, fetchJson, fetchText } from "./http.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function bodyResponse(ok: boolean, kind: "text" | "json", consume: () => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok, status: ok ? 200 : 503, [kind]: consume })));
}

describe("response-body deadline", () => {
  it.each(["text", "json"] as const)("bounds a stalled %s success body even if it ignores abort", async (kind) => {
    vi.useFakeTimers();
    bodyResponse(true, kind, () => new Promise(() => {}));
    const request = kind === "text" ? fetchText("https://example.test", { timeoutMs: 50 }) : fetchJson("https://example.test", { timeoutMs: 50 });
    const assertion = expect(request).rejects.toMatchObject({ name: "RequestTimeoutError", timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("uses a single budget for headers and body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => setTimeout(() => resolve({ ok: true, text: () => new Promise(() => {}) }), 30))));
    const assertion = expect(fetchText("https://example.test", { timeoutMs: 50 })).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled error-body consumption", async () => {
    vi.useFakeTimers();
    bodyResponse(false, "text", () => new Promise(() => {}));
    const assertion = expect(fetchJson("https://example.test", { timeoutMs: 50 })).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("preserves a caller abort during body consumption", async () => {
    const controller = new AbortController();
    bodyResponse(true, "text", () => new Promise(() => {}));
    const reason = new Error("caller stopped");
    const request = fetchText("https://example.test", { timeoutMs: 100, signal: controller.signal });
    const assertion = expect(request).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
  });

  it("does not send requests when already aborted", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const reason = new Error("already stopped");
    await expect(fetchJson("https://example.test", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cleans the deadline after successful parsing", async () => {
    vi.useFakeTimers();
    bodyResponse(true, "json", async () => ({ value: 42 }));
    await expect(fetchJson("https://example.test", { timeoutMs: 50 })).resolves.toEqual({ value: 42 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves parse and HTTP errors before the deadline", async () => {
    const parseError = new SyntaxError("invalid JSON");
    bodyResponse(true, "json", async () => { throw parseError; });
    await expect(fetchJson("https://example.test")).rejects.toBe(parseError);
    bodyResponse(false, "text", async () => "unavailable");
    await expect(fetchText("https://example.test")).rejects.toBeInstanceOf(HttpError);
  });

  it("aborts the transport on the deadline", async () => {
    vi.useFakeTimers();
    let received: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => { received = init.signal; return { ok: true, json: () => new Promise(() => {}) }; }));
    const assertion = expect(fetchJson("https://example.test", { timeoutMs: 50 })).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(received?.aborted).toBe(true);
  });
});

it.each(["text", "json", "error"] as const)("normalizes a stalled native HTTP %s body", async (kind) => {
  const { createServer } = await import("node:http");
  let bodyStarted = false;
  const server = createServer((_request, response) => {
    bodyStarted = true;
    response.writeHead(kind === "error" ? 503 : 200);
    response.write(kind === "json" ? '{"value":' : "partial body");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback listener");
  try {
    const url = `http://127.0.0.1:${address.port}`;
    const request = kind === "text" ? fetchText(url, { timeoutMs: 100 }) : fetchJson(url, { timeoutMs: 100 });
    await expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(bodyStarted).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
