/**
 * Timers that never throw and all stop together. A job runs, then the next run
 * is scheduled: a slow request delays its own next run instead of piling up.
 */
export class Scheduler {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly onError: (err: unknown) => void) {}

  /** Run `fn` after `firstDelayMs`, then every `intervalMs` after it ends. */
  every(intervalMs: number, fn: () => Promise<void>, firstDelayMs = 0): void {
    const tick = async () => {
      await this.safely(fn);
      this.after(intervalMs, tick);
    };
    this.after(firstDelayMs, tick);
  }

  /** Run `fn` once after `ms`. */
  after(ms: number, fn: () => Promise<void>): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.safely(fn);
    }, ms);
    this.timers.add(timer);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private async safely(fn: () => Promise<void>): Promise<void> {
    if (this.stopped) return;
    try {
      await fn();
    } catch (err) {
      this.onError(err);
    }
  }
}
