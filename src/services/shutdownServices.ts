type ShutdownService = { name: string; stop: () => void | Promise<void> };

export async function shutdownServices(
  services: ShutdownService[],
  onFailure: (service: string, error: unknown) => void
): Promise<0 | 1> {
  // Invoke through promises so a synchronous throw cannot skip other cleanup.
  const results = await Promise.allSettled(
    services.map(({ stop }) => Promise.resolve().then(stop))
  );
  let exitCode: 0 | 1 = 0;
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      exitCode = 1;
      onFailure(services[index]!.name, result.reason);
    }
  });
  return exitCode;
}
