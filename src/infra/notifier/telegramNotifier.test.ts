import { afterEach, describe, expect, it, vi } from "vitest";

import { TelegramNotifier } from "./telegramNotifier.js";

describe("TelegramNotifier", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const fixture = (token: string | undefined = "fixture-token", chatId: string | undefined = "fixture-chat") => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    return { logger, notifier: new TelegramNotifier(token, chatId, logger as never) };
  };

  it("skips delivery when credentials are absent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { notifier, logger } = fixture("");
    await notifier.notify("fixture");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledOnce();
  });

  it("sends a successful notification once and releases its unused response body", async () => {
    const response = new Response("ok");
    const cancel = vi.spyOn(response.body!, "cancel");
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const { notifier, logger } = fixture();
    await notifier.notify("fixture");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ chat_id: "fixture-chat", text: "fixture" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([401, 429, 503])("warns about HTTP %s without recording sensitive response content", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("sensitive remote diagnostic", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const { notifier, logger } = fixture();
    await expect(notifier.notify("private message")).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({ status }, "Telegram notification rejected");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/fixture-token|private message|sensitive remote/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts a stalled fetch within the configured budget and returns without retrying", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(10));
    const fetchMock = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { notifier, logger } = fixture();
    await expect(notifier.notify("fixture")).resolves.toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("keeps transport failures nonfatal and redacts the credential-bearing error message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("https://api.telegram.org/botfixture-token/sendMessage")));
    const { notifier, logger } = fixture();
    await expect(notifier.notify("fixture")).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("fixture-token");
  });
});
