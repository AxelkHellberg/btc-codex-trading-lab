import type { MarketSnapshot } from "../domain/types.js";

type ComponentStatus = "up" | "down" | "timeout";
export type ReadinessResult = {
  ready: boolean;
  components: Record<string, ComponentStatus>;
};

// A timed-out command remains shared until it settles. HTTP timeouts must not
// produce an unbounded backlog of SELECT/PING commands against an unavailable peer.
const dependencyCheck = (probe: () => Promise<void>): (() => Promise<ComponentStatus>) => {
  let active: Promise<ComponentStatus> | null = null;
  return async () => {
    if (!active) {
      const operation = Promise.resolve().then(probe).then<ComponentStatus, ComponentStatus>(
        () => "up", () => "down"
      ).finally(() => { if (active === operation) active = null; });
      active = operation;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        active,
        new Promise<ComponentStatus>(resolve => { timer = setTimeout(() => resolve("timeout"), 1_000); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
};

export const createReadinessCheck = (dependencies: {
  isRunning: () => boolean;
  getMarket: () => MarketSnapshot | null;
  postgres: () => Promise<void>;
  redis: () => Promise<void>;
}): (() => Promise<ReadinessResult>) => {
  const postgres = dependencyCheck(dependencies.postgres);
  const redis = dependencyCheck(dependencies.redis);
  return async () => {
    const [postgresStatus, redisStatus] = await Promise.all([postgres(), redis()]);
    const timestamp = dependencies.getMarket()?.timestamp;
    const age = timestamp === undefined ? NaN : Date.now() - timestamp;
    const components: ReadinessResult["components"] = {
      startup: dependencies.isRunning() ? "up" : "down",
      postgres: postgresStatus,
      redis: redisStatus,
      market: Number.isFinite(age) && age >= 0 && age <= 90_000 ? "up" : "down"
    };
    return { ready: Object.values(components).every(status => status === "up"), components };
  };
};
