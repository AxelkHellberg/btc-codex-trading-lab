// Keep this probe dependency-free so it also works in the runtime image.
const port = Number(process.env.APP_PORT ?? 3000);

try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid APP_PORT");
  }
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    signal: AbortSignal.timeout(3000),
    redirect: "error"
  });
  if (response.status !== 200 || (await response.json())?.ok !== true) {
    throw new Error("Unhealthy response");
  }
} catch {
  console.error("App healthcheck failed");
  process.exitCode = 1;
}
