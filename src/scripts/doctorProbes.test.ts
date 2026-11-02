import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../config.js";
import { probeDoctor, PROBE_TIMEOUT_MS, runProbeCommand, withDeadline } from "./doctorProbes.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(), query: vi.fn(), end: vi.fn(), redisConnect: vi.fn(), ping: vi.fn(),
  disconnect: vi.fn(), spawn: vi.fn()
}));
vi.mock("pg", () => ({ Client: class {
  on() {} connect = mocks.connect; query = mocks.query; end = mocks.end;
} }));
vi.mock("ioredis", () => ({ Redis: class {
  on() {} connect = mocks.redisConnect; ping = mocks.ping; disconnect = mocks.disconnect;
} }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
const never = () => new Promise<never>(() => undefined);
const child = () => Object.assign(new EventEmitter(), {
  pid: 424242, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn()
});

beforeEach(() => {
  vi.useFakeTimers();
  mocks.connect.mockResolvedValue(undefined); mocks.query.mockResolvedValue(undefined);
  mocks.end.mockResolvedValue(undefined); mocks.redisConnect.mockResolvedValue(undefined);
  mocks.ping.mockResolvedValue("PONG"); mocks.disconnect.mockReset();
  mocks.spawn.mockImplementation(() => {
    const proc = child(); Promise.resolve().then(() => proc.emit("close", 0)); return proc;
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, ts: 1 }) }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("doctor probe deadlines", () => {
  it("clears deadlines on success and rejection", async () => {
    expect(await withDeadline(async () => 1)).toBe(1);
    await expect(withDeadline(async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["connect", "query", "redisConnect", "ping", "headers", "body"] as const)(
    "reports a stalled %s probe and finishes the remaining report", async (stalled) => {
      if (stalled in mocks) (mocks[stalled as "connect"]).mockImplementationOnce(never);
      if (stalled === "headers") vi.mocked(fetch).mockImplementationOnce(never);
      if (stalled === "body") vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: never } as never);
      const reportPromise = probeDoctor(config);
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1_000);
      const report = await reportPromise;
      const failing = ["connect", "query"].includes(stalled) ? "postgres"
        : ["redisConnect", "ping"].includes(stalled) ? "redis" : "app";
      expect(report.checks[failing as "app"]).toBe("down");
      for (const check of ["app", "postgres", "redis", "binance"] as const) {
        if (check !== failing) expect(report.checks[check]).toBe("ok");
      }
      expect(report.codex.code).toBe(0);
      expect(mocks.disconnect).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("bounds stalled PostgreSQL cleanup as well", async () => {
    mocks.end.mockImplementationOnce(never);
    const reportPromise = probeDoctor(config);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await reportPromise).checks.postgres).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts a timed-out HTTP body and rejects invalid app contracts", async () => {
    const http = vi.fn().mockImplementationOnce(async (_url, options) => {
      expect(options.signal.aborted).toBe(false);
      return { ok: true, json: never };
    }).mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", http);
    const p = probeDoctor(config);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect((await p).checks.app).toBe("down");
    expect(http.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it.each([{ ok: false, ts: 1 }, { ok: true }, { ok: "true", ts: 1 }, { ok: true, ts: NaN }])(
    "rejects an invalid app success body %j", async (body) => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => body } as never);
      expect((await probeDoctor(config)).checks.app).toBe("down");
    }
  );

  it("terminates a stalled CLI process group even after its launcher closes", async () => {
    const proc = child(); mocks.spawn.mockReturnValueOnce(proc);
    const kill = vi.spyOn(process, "kill").mockImplementation((() => {
      proc.emit("close", null); return true;
    }) as typeof process.kill);
    const result = runProbeCommand("node", ["fixture"]);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(kill).toHaveBeenCalledWith(-424242, "SIGTERM");
    await vi.advanceTimersByTimeAsync(250);
    expect(kill).toHaveBeenCalledWith(-424242, "SIGKILL");
    expect(await result).toMatchObject({ code: 124, timedOut: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports spawn errors without leaving a deadline", async () => {
    const proc = child(); mocks.spawn.mockReturnValueOnce(proc);
    const p = runProbeCommand("missing", []); proc.emit("error", new Error("not found"));
    expect(await p).toMatchObject({ code: 1, timedOut: false, stderr: "not found" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
