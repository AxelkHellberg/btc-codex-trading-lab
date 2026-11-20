import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchJson, HttpError } from "./http.js";

const headerFormats: Array<{
  name: string;
  create: (values: Record<string, string>) => HeadersInit;
}> = [
  { name: "record", create: (values) => ({ ...values }) },
  { name: "Headers", create: (values) => new Headers(values) },
  { name: "tuples", create: (values) => Object.entries(values) }
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJson request headers", () => {
  for (const format of headerFormats) {
    it(`preserves ${format.name} headers alongside the JSON default`, async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);
      const supplied = format.create({ Authorization: "Bearer fixture", "X-Trace": "trace-1" });
      const original = [...new Headers(supplied)];

      await expect(fetchJson("https://example.test/data", { headers: supplied })).resolves.toEqual({ ok: true });

      const [, request] = fetchMock.mock.calls[0]!;
      expect([...new Headers(request?.headers)]).toEqual([
        ["accept", "application/json"],
        ["authorization", "Bearer fixture"],
        ["x-trace", "trace-1"]
      ]);
      expect([...new Headers(supplied)]).toEqual(original);
    });

    it(`honors an explicit mixed-case Accept in ${format.name} headers`, async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);
      const supplied = format.create({ AcCePt: "application/problem+json" });

      await fetchJson("https://example.test/data", { headers: supplied });

      const [, request] = fetchMock.mock.calls[0]!;
      expect(new Headers(request?.headers).get("accept")).toBe("application/problem+json");
      expect([...new Headers(supplied)]).toEqual([["accept", "application/problem+json"]]);
    });
  }

  it("preserves an explicitly empty Accept value", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchJson("https://example.test/data", { headers: { ACCEPT: "" } });

    const [, request] = fetchMock.mock.calls[0]!;
    expect(new Headers(request?.headers).get("accept")).toBe("");
  });

  it("keeps other request options and supplies the default when headers are omitted", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: 7 }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const init: RequestInit = {
      method: "POST",
      body: '{"name":"fixture"}',
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal
    };

    await expect(fetchJson<{ id: number }>("https://example.test/data", init)).resolves.toEqual({ id: 7 });

    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://example.test/data");
    expect(request).toMatchObject(init);
    expect(request?.signal).toBe(controller.signal);
    expect([...new Headers(request?.headers)]).toEqual([["accept", "application/json"]]);
    expect(init.headers).toBeUndefined();
  });

  it("retains the HTTP failure contract", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("fixture failure", { status: 429 })));

    const outcome = fetchJson("https://example.test/data", {
      headers: new Headers({ "X-Trace": "trace-1" })
    });

    await expect(outcome).rejects.toBeInstanceOf(HttpError);
    await expect(outcome).rejects.toMatchObject({
      name: "HttpError",
      status: 429,
      message: "fixture failure"
    });
  });
});
