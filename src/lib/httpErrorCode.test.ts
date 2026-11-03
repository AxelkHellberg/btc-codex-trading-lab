import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "./http.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const request = () => fetchJson("https://example.test/signed?signature=private", undefined, { captureErrorCode: true });
describe("bounded signed API error metadata", () => {
  it("retains only the numeric code from a complete small response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"code":-1021,"msg":"private key or proxy diagnostic"}', { status: 400 })));
    const error: unknown = await request().catch(error => error);
    expect(error).toMatchObject({ code: -1021, status: 400 });
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected HTTP error");
    expect(error.message).not.toContain("private"); expect(error.message).not.toContain("signature");
  });
  it.each(['{"code":"-1021"}', '{"code":-1021.5}', 'null', 'not json', '{"code":-1021,"msg":"' + 'x'.repeat(1024) + '"}'])("does not classify invalid or oversized bodies", async body => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 400 })));
    await expect(request()).rejects.toMatchObject({ status: 400, code: undefined });
  });
  it("bounds a body that never finishes and cancels its reader", async () => {
    vi.useFakeTimers(); const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"code":-1021'));
    }, cancel }), { status: 400 })));
    const rejected = expect(request()).rejects.toMatchObject({ status: 400, code: undefined });
    await vi.advanceTimersByTimeAsync(1_000); await rejected; expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
