import { afterEach, describe, expect, it, vi } from "vitest";

import { probeAppHealth } from "./appHealth.js";

afterEach(() => vi.unstubAllGlobals());

describe("doctor app-health probe", () => {
  const url = "http://127.0.0.1:3000/healthz";

  it("accepts a successful response with an explicit healthy payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(probeAppHealth(url)).resolves.toEqual({ state: "ok", status: 200 });
    expect(fetchMock).toHaveBeenCalledWith(url);
  });

  it.each(['{"ok":true}', "<html>unavailable</html>", ""])(
    "reports HTTP failures with status regardless of body: %j", async (body) => {
      const response = new Response(body, { status: 503 });
      const json = vi.spyOn(response, "json");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(probeAppHealth(url)).resolves.toEqual({ state: "down", status: 503, reason: "http_error" });
      expect(json).not.toHaveBeenCalled();
      expect(response.body?.locked).toBe(false);
    }
  );

  it.each([null, [], {}, { ok: false }, { ok: "true" }, { ok: 1 }])(
    "rejects an unhealthy or malformed payload: %j", async (payload) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(payload)));
      await expect(probeAppHealth(url)).resolves.toEqual({ state: "down", status: 200, reason: "unhealthy_payload" });
    }
  );

  it.each(["", "not JSON", "<html>unexpected proxy</html>"])(
    "keeps status when a successful response has invalid JSON: %j", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
      await expect(probeAppHealth(url)).resolves.toEqual({ state: "down", status: 200, reason: "invalid_json" });
    }
  );

  it("distinguishes transport failure from an HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    await expect(probeAppHealth(url)).resolves.toEqual({ state: "down", reason: "request_failed" });
  });
});
