import "dotenv/config";

const pid = Number(process.argv[2]);
const port = Number(process.env.APP_PORT ?? 3000);
const timeoutSeconds = Number(process.env.DAEMON_STARTUP_TIMEOUT_SECONDS ?? 30);

const alive = () => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

async function waitForDaemon() {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isInteger(port) || port < 1 || port > 65535
      || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
    throw new Error("Invalid daemon PID, APP_PORT, or DAEMON_STARTUP_TIMEOUT_SECONDS (1–300)");
  }
  const deadline = performance.now() + timeoutSeconds * 1000;
  while (performance.now() < deadline) {
    if (!alive()) throw new Error("Daemon exited before becoming healthy");
    const remaining = deadline - performance.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(1000, remaining)))),
        redirect: "error"
      });
      const body = await response.json();
      if (response.ok && body?.ok === true && body.pid === pid
          && Number.isFinite(body.ts) && alive() && performance.now() < deadline) return;
    } catch {
      // Connection refusal, malformed bodies and timeouts are retryable only
      // inside this one startup budget. The child's log has failure details.
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(100, deadline - performance.now()))));
  }
  throw new Error(`Daemon health was not confirmed within ${timeoutSeconds}s`);
}

await waitForDaemon().catch((error) => {
  console.error(`${error.message}; see logs/app.log`);
  process.exitCode = 1;
});
