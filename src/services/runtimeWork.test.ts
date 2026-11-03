import { describe, expect, it, vi } from "vitest";
import { RuntimeWork } from "./runtimeWork.js";

describe("RuntimeWork", () => {
  it("retains synchronous and asynchronous failures without blocking drain", async () => {
    const work = new RuntimeWork();
    const first = work.run(() => { throw new Error("sync"); });
    const second = work.run(async () => { throw new Error("async"); });
    await expect(first).rejects.toThrow("sync"); await expect(second).rejects.toThrow("async");
    await work.drain(); const late = vi.fn(); await work.run(late); expect(late).not.toHaveBeenCalled();
  });
});
