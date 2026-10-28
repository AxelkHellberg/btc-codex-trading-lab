import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, HttpError, InvalidJsonResponseError } from "./http.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("successful HTTP responses with invalid JSON", () => {
  it.each(["", "<html>proxy error</html>", "not json", '{"balance":', "{", "undefined"])(
    "reports endpoint and HTTP context for %j without echoing the payload", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
        status: 200, headers: { "content-type": "text/html; charset=utf-8" }
      })));
      const result = await fetchJson("https://user:password@example.test/fapi/v3/balance?signature=private&timestamp=123")
        .catch((error: unknown) => error);
      expect(result).toBeInstanceOf(HttpError);
      expect(result).toMatchObject({
        name: "InvalidJsonResponseError", status: 200,
        endpoint: "https://example.test/fapi/v3/balance", contentType: "text/html"
      });
      expect((result as Error).message).toContain("HTTP 200");
      expect((result as Error).message).toContain("https://example.test/fapi/v3/balance");
      expect((result as Error).message).not.toMatch(/password|signature|private|timestamp|proxy error|balance\"/);
    }
  );

  it("bounds diagnostic metadata and handles an absent content type", async () => {
    const response = new Response("");
    response.headers.delete("content-type");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const error = await fetchJson("https://example.test/" + "a".repeat(5_000)).catch((value) => value);
    expect(error).toBeInstanceOf(InvalidJsonResponseError);
    if (!(error instanceof InvalidJsonResponseError)) throw new Error("Expected a JSON response error");
    expect(error.contentType).toBe("unknown");
    expect(error.endpoint.length).toBeLessThanOrEqual(300);
    expect(error.message.length).toBeLessThan(500);
  });

  it.each([{ ok: true }, [1, 2], null, 42, "hello"])("returns valid JSON unchanged: %j", async (value) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(value))));
    await expect(fetchJson("https://example.test/data")).resolves.toEqual(value);
  });

  it("preserves body transport failures instead of misclassifying them as JSON syntax errors", async () => {
    const aborted = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(aborted) }));
    await expect(fetchJson("https://example.test/data")).rejects.toBe(aborted);
  });

  it("preserves request options and non-success HttpError behavior", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("upstream failure", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const init = { method: "POST", body: "request", signal, headers: { "x-test": "present" } };
    await expect(fetchJson("https://example.test/data", init)).rejects.toMatchObject({ name: "HttpError", status: 503 });
    expect(fetch).toHaveBeenCalledWith("https://example.test/data", {
      ...init, headers: { accept: "application/json", "x-test": "present" }
    });
  });
});
