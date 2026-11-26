import { createServer } from "node:http";

import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config } from "../config.js";
import { RequestTimeoutError } from "../lib/http.js";
import { NewsIngestor } from "./newsIngestor.js";

const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Fixture feed</title>
<item><title>Bitcoin adoption grows</title><link>https://example.test/story</link>
<pubDate>Thu, 26 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

function buildIngestor(feeds: string[]) {
  const warn = vi.fn();
  const onEvents = vi.fn();
  const ingestor = new NewsIngestor(
    { ...config, feeds: { news: feeds, macro: [] } },
    { warn } as unknown as Logger,
    onEvents
  );
  return { ingestor, warn, onEvents };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RSS request deadlines", () => {
  it("aborts a stalled body, logs its timeout, and delivers healthy feeds", async () => {
    vi.useFakeTimers();
    let stalledSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/stalled")) {
        stalledSignal = init?.signal ?? undefined;
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/rss+xml" }),
          arrayBuffer: () => new Promise<ArrayBuffer>(() => {})
        };
      }
      return new Response(feedXml, { headers: { "content-type": "application/rss+xml" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ingestor, warn, onEvents } = buildIngestor([
      "http://127.0.0.1:1/stalled", "http://127.0.0.1:1/healthy"
    ]);
    try {
      const startup = ingestor.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stalledSignal?.aborted).toBe(true);
      await startup;
      expect(warn).toHaveBeenCalledWith(
        { error: expect.any(RequestTimeoutError), feed: "http://127.0.0.1:1/stalled" },
        "Failed to fetch RSS feed"
      );
      expect(onEvents).toHaveBeenCalledOnce();
      expect(onEvents.mock.calls[0]?.[0]).toMatchObject([{
        source: "Fixture feed", title: "Bitcoin adoption grows", tags: ["news", "bitcoin"]
      }]);
      expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
        "User-Agent": "rss-parser", Accept: "application/rss+xml"
      });
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      ingestor.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates HTTP and malformed XML failures from a valid redirected feed", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/valid" }).end();
      } else if (request.url === "/failed") {
        response.writeHead(503).end("unavailable");
      } else if (request.url === "/malformed") {
        response.writeHead(200).end("not an RSS document");
      } else {
        response.writeHead(200, { "content-type": "application/rss+xml" }).end(feedXml);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback listener");
    const root = `http://127.0.0.1:${address.port}`;
    const { ingestor, warn, onEvents } = buildIngestor([
      `${root}/failed`, `${root}/malformed`, `${root}/redirect`
    ]);
    try {
      await ingestor.start();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(onEvents).toHaveBeenCalledOnce();
      expect(onEvents.mock.calls[0]?.[0]).toMatchObject([{
        title: "Bitcoin adoption grows", url: "https://example.test/story"
      }]);
    } finally {
      ingestor.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    ["iso-8859-1", "latin1"], ["utf-8", "utf8"], ["unknown", "utf8"]
  ] as const)("preserves RSS text declared as %s", async (charset, encoding) => {
    vi.useFakeTimers();
    const xml = feedXml.replace("Bitcoin adoption grows", "Bitcoin café adoption grows");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from(xml, encoding), {
      headers: { "content-type": `application/rss+xml; charset=${charset}` }
    })));
    const { ingestor, warn, onEvents } = buildIngestor(["http://127.0.0.1:1/feed"]);
    try {
      await ingestor.start();
      expect(warn).not.toHaveBeenCalled();
      expect(onEvents.mock.calls[0]?.[0]).toMatchObject([{ title: "Bitcoin café adoption grows" }]);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      ingestor.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes a native stalled RSS response on the shared deadline", async () => {
    let bodyStarted = false;
    let responseClosed = false;
    const server = createServer((_request, response) => {
      bodyStarted = true;
      response.on("close", () => { responseClosed = true; });
      response.writeHead(200, { "content-type": "application/rss+xml" });
      response.write("<rss version=\"2.0\"><channel>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback listener");
    const { ingestor, warn, onEvents } = buildIngestor([`http://127.0.0.1:${address.port}/stalled`]);
    try {
      await ingestor.start();
      expect(bodyStarted).toBe(true);
      await vi.waitFor(() => expect(responseClosed).toBe(true));
      expect(warn.mock.calls[0]?.[0].error).toBeInstanceOf(RequestTimeoutError);
      expect(onEvents).not.toHaveBeenCalled();
    } finally {
      ingestor.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);
});
