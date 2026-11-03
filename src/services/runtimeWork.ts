/** Admit work synchronously, then retain it until all store and lock use settles. */
export class RuntimeWork {
  private accepting = true;
  private readonly pending = new Set<Promise<void>>();

  public run(work: () => Promise<void> | void): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    const task = Promise.resolve().then(work);
    this.pending.add(task);
    const remove = () => { this.pending.delete(task); };
    void task.then(remove, remove);
    return task;
  }

  public close(): void { this.accepting = false; }

  public async drain(): Promise<void> {
    this.close();
    await Promise.allSettled([...this.pending]);
  }
}
