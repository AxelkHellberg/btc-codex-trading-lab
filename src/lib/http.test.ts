import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RequestTimeoutError, fetchJson, fetchText } from "./http.js";

describe("http timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("aborts stalled JSON requests after the timeout budget", async () => {
    global.fetch = vi.fn((_input, init) => {
      const signal = init?.signal as AbortSignal;

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const request = fetchJson("https://example.com/data", { timeoutMs: 250 });

    await vi.advanceTimersByTimeAsync(250);

    await expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it("applies the same timeout budget to text requests", async () => {
    global.fetch = vi.fn((_input, init) => {
      const signal = init?.signal as AbortSignal;

      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const request = fetchText("https://example.com/height", { timeoutMs: 250 });

    await vi.advanceTimersByTimeAsync(250);

    await expect(request).rejects.toBeInstanceOf(RequestTimeoutError);
  });
});
