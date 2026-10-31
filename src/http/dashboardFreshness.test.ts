import { createContext, runInContext } from "node:vm";
import { setImmediate } from "node:timers/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeState } from "../services/runtimeState.js";
import { createHttpServer } from "./server.js";

const routes = vi.hoisted(() => new Map<string, (...args: any[]) => unknown>());
vi.mock("fastify", () => ({
  default: () => ({
    get: (path: string, handler: (...args: any[]) => unknown) => routes.set(path, handler),
    post: vi.fn(), listen: vi.fn(), close: vi.fn(), ready: vi.fn(), inject: vi.fn()
  })
}));

beforeEach(() => routes.clear());

async function dashboard(fetchMock: ReturnType<typeof vi.fn>) {
  await createHttpServer(new RuntimeState(10_000), 3000);
  let html = "";
  const reply = { type: () => reply, send: (value: string) => { html = value; } };
  await routes.get("/")!(null, reply);
  const nodes = new Map<string, any>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", innerHTML: "", dataset: {}, addEventListener: vi.fn() });
    return nodes.get(id);
  };
  let interval: (() => void) | undefined;
  const context = createContext({
    document: { getElementById: node }, fetch: fetchMock, console: { error: vi.fn() },
    setInterval: (callback: () => void) => { interval = callback; }
  });
  runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1]!, context);
  await setImmediate();
  return { context, node, poll: async () => { interval!(); await setImmediate(); }, html };
}

const payload = () => ({
  account: { equity: 10_000, walletBalance: 10_000, dailyPnl: 0, updatedAt: 1 },
  position: { side: "flat", quantity: 0 }, recentDecisions: [], recentTrades: []
});
const success = () => ({ ok: true, json: async () => payload() });

describe("dashboard freshness", () => {
  it.each(["network", "http", "json"])("marks a recurring %s failure stale and recovers", async (failure) => {
    const badJson = vi.fn().mockRejectedValue(new SyntaxError("invalid JSON"));
    const fetchMock = vi.fn().mockResolvedValueOnce(success());
    if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("offline"));
    if (failure === "http") fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: badJson });
    if (failure === "json") fetchMock.mockResolvedValueOnce({ ok: true, json: badJson });
    fetchMock.mockResolvedValueOnce(success());
    const page = await dashboard(fetchMock);
    const liveText = page.node("heartbeat").textContent;
    expect(liveText).toMatch(/^Live · /);

    await page.poll();
    expect(page.node("heartbeat").textContent).toBe(liveText.replace("Live · ", "Stale · last update "));
    expect(page.node("dashboardStatus").dataset.state).toBe("stale");
    expect(page.node("equity").textContent).toBe("$10,000.00");
    if (failure === "http") expect(badJson).not.toHaveBeenCalled();

    await page.poll();
    expect(page.node("dashboardStatus").dataset.state).toBe("live");
    expect(page.node("heartbeat").textContent).toMatch(/^Live · /);
  });

  it("shows unavailable before the first successful payload and then recovers", async () => {
    const page = await dashboard(vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(success()));
    expect(page.node("dashboardStatus").dataset.state).toBe("error");
    expect(page.node("heartbeat").textContent).toBe("Dashboard unavailable");
    await page.poll();
    expect(page.node("dashboardStatus").dataset.state).toBe("live");
  });

  it("does not label an incomplete render live", async () => {
    const page = await dashboard(vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    expect(page.node("dashboardStatus").dataset.state).toBe("error");
    expect(page.node("heartbeat").textContent).toBe("Dashboard unavailable");
  });

  it("announces freshness accessibly and removes green styling for stale data", async () => {
    const page = await dashboard(vi.fn().mockResolvedValue(success()));
    expect(page.html).toContain('role="status" aria-live="polite"');
    expect(page.html).toContain('.status-pill[data-state="stale"] .dot');
    expect(page.html).toContain('background: var(--amber)');
  });
});


const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("dashboard single-flight polling", () => {
  it("shares startup work across timer ticks and explicit refresh calls", async () => {
    const response = deferred<ReturnType<typeof success>>();
    const fetchMock = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue(success());
    const page = await dashboard(fetchMock);
    await page.poll(); await page.poll();
    const first = runInContext("refresh()", page.context);
    const second = runInContext("refresh()", page.context);
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    response.resolve(success()); await first;
    expect(page.node("dashboardStatus").dataset.state).toBe("live");
    await page.poll(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("holds the gate through JSON parsing and rendering", async () => {
    const body = deferred<ReturnType<typeof payload>>();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: () => body.promise })
      .mockResolvedValue({ ok: true, json: async () => ({ ...payload(), account: { ...payload().account, equity: 20_000 } }) });
    const page = await dashboard(fetchMock);
    await page.poll(); await page.poll();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    body.resolve(payload()); await setImmediate();
    expect(page.node("equity").textContent).toBe("$10,000.00");
    await page.poll(); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.node("equity").textContent).toBe("$20,000.00");
  });
  it("releases the gate after failure so polling can recover", async () => {
    const response = deferred<ReturnType<typeof success>>();
    const fetchMock = vi.fn().mockReturnValueOnce(response.promise).mockResolvedValue(success());
    const page = await dashboard(fetchMock);
    await page.poll(); expect(fetchMock).toHaveBeenCalledTimes(1);
    response.reject(new Error("offline")); await setImmediate();
    expect(page.node("dashboardStatus").dataset.state).toBe("error");
    await page.poll(); expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(page.node("dashboardStatus").dataset.state).toBe("live");
  });
});
