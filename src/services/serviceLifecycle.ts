export interface ManagedService {
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void> | void;
}

export interface CleanupFailure { name: string; error: unknown }

/** Own resources before starting them, including a start that can fail partway. */
export class ServiceLifecycle {
  private readonly resources: Pick<ManagedService, "name" | "stop">[] = [];
  private stopping: Promise<CleanupFailure[]> | undefined;

  public own(name: string, stop: ManagedService["stop"]): void {
    if (this.stopping) throw new Error("Cannot register resources after teardown begins");
    this.resources.push({ name, stop });
  }

  public async start(services: ManagedService[]): Promise<void> {
    try {
      // Sequential startup makes resource ownership and rollback order explicit.
      for (const service of services) {
        this.own(service.name, service.stop);
        await service.start();
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  public stop(): Promise<CleanupFailure[]> {
    if (!this.stopping) {
      this.stopping = (async () => {
        const failures: CleanupFailure[] = [];
        for (const resource of [...this.resources].reverse()) {
          try { await resource.stop(); }
          catch (error) { failures.push({ name: resource.name, error }); }
        }
        return failures;
      })();
    }
    return this.stopping;
  }
}
