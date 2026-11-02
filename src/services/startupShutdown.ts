export class StartupInterrupted extends Error {
  public constructor() { super("Startup interrupted by shutdown request"); }
}

/** Delay teardown until the current startup operation has settled, then stop once. */
export class StartupShutdown {
  private readonly startupDone: Promise<void>;
  private resolveStartup!: () => void;
  private stopRequested = false;
  private startupFailed = false;
  private exited = false;

  public constructor(
    private readonly cleanup: () => Promise<void>,
    private readonly exit: (code: number) => void,
    private readonly reportFailure: (error: unknown) => void,
    private readonly timeoutMs = 10_000
  ) {
    this.startupDone = new Promise(resolve => { this.resolveStartup = resolve; });
  }

  public checkpoint = (): void => {
    if (this.stopRequested) throw new StartupInterrupted();
  };

  public request = (): void => {
    if (this.stopRequested) return;
    this.stopRequested = true;
    const finish = (code: number) => {
      if (this.exited) return;
      this.exited = true;
      this.exit(code);
    };
    const timer = setTimeout(() => {
      this.reportFailure(new Error("Shutdown deadline expired while startup or cleanup was still pending"));
      finish(1);
    }, this.timeoutMs);
    void (async () => {
      try {
        await this.startupDone;
        await this.cleanup();
        finish(this.startupFailed ? 1 : 0);
      } catch (error) {
        this.reportFailure(error);
        finish(1);
      } finally { clearTimeout(timer); }
    })();
  };

  public finishStartup(failed = false): void {
    this.startupFailed = failed;
    this.resolveStartup();
  }
}
