import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchJson, HttpError } from "./http.js";

afterEach(() => vi.unstubAllGlobals());

describe("fetchJson", () => {
  it.each([
    "upstream unavailable",
    "x".repeat(1_000_000),
    "secret\r\nforged log\u0000\u001b[31m"
  ])("does not retain an upstream error body (case %#)", async (body) => {
    const response = new Response(body, { status: 503 });
    const text = vi.spyOn(response, "text");
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    const error = await fetchJson("https://example.test/data?token=secret").catch(
      (error: unknown) => error
    );

    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 503, message: "HTTP request failed (status 503)" });
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves the HTTP error if cancelling the body rejects", async () => {
    const response = new Response("unavailable", { status: 429 });
    vi.spyOn(response.body!, "cancel").mockRejectedValue(new Error("cancel failed"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(fetchJson("https://example.test")).rejects.toMatchObject({
      name: "HttpError", status: 429, message: "HTTP request failed (status 429)"
    });
  });

  it("accepts an error response without a body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 502 })));
    await expect(fetchJson("https://example.test")).rejects.toMatchObject({ status: 502 });
  });

  it("returns successful JSON and forwards request options", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ value: 42 }));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();

    await expect(fetchJson("https://example.test", {
      signal: controller.signal, headers: { authorization: "Bearer example" }
    })).resolves.toEqual({ value: 42 });
    expect(fetch).toHaveBeenCalledWith("https://example.test", {
      signal: controller.signal,
      headers: { accept: "application/json", authorization: "Bearer example" }
    });
  });
});
