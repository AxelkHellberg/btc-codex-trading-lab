type HeartbeatStage = "persist" | "recheck";

export function startHeartbeatLoop(
  persist: () => Promise<void>,
  recheck: () => Promise<void>,
  onError: (stage: HeartbeatStage, error: unknown) => void,
  intervalMs = 60_000
): { stop: () => Promise<void> } {
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const timer = setInterval(() => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = (async () => {
      for (const [stage, task] of [["persist", persist], ["recheck", recheck]] as const) {
        if (stopped) {
          break;
        }
        try {
          await task();
        } catch (error) {
          onError(stage, error);
        }
      }
    })().finally(() => {
      inFlight = null;
    });
  }, intervalMs);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    }
  };
}
