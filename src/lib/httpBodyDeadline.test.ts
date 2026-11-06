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
