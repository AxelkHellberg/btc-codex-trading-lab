import { config } from "../config.js";
import { logger } from "../logger.js";
import { probeDoctor } from "./doctorProbes.js";

const main = async (): Promise<void> => {
  const report = await probeDoctor(config);
  logger.info(report, "Runtime doctor");
  const healthy = [report.checks.app, report.checks.postgres, report.checks.redis, report.checks.binance]
    .every(state => state === "ok") && report.codex.code === 0;
  // This one-shot diagnostic must exit even if an unresponsive driver retains a handle.
  process.exit(healthy ? 0 : 1);
};

void main().catch((error) => {
  logger.error({ error }, "Doctor failed");
  process.exit(1);
});
