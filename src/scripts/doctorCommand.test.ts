import { expect, it } from "vitest";
import { runProbeCommand } from "./doctorProbes.js";

it("stops an actual unresponsive local child within the diagnostic budget", async () => {
  const result = await runProbeCommand(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"]);
  expect(result).toMatchObject({ code: 124, timedOut: true });
}, 10_000);
