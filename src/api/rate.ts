import { RenaultError } from "./errors.js";

const HOUR_MS = 3_600_000;

export interface RateLimiterOptions {
  /** Requests allowed per rolling hour, all cars of the account together. */
  perHour: number;
  now?: () => number;
}

/**
 * One request at a time, at most `perHour` per rolling hour, and a global
 * pause after `overloaded`. Work waits instead of failing: a poll late by a
 * few minutes is harmless, a throttled account is not.
 */
export class RateLimiter {
  private readonly perHour: number;
  private readonly now: () => number;
  private readonly sent: number[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private pausedUntil = 0;
  private closed = false;
  private readonly waits = new Set<() => void>();

  constructor(opts: RateLimiterOptions) {
    this.perHour = opts.perHour;
    this.now = opts.now ?? Date.now;
  }

  /** Run `fn` when the budget allows, after every request queued before it. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.slot();
      return fn();
    });
    // The queue goes on whatever this request does.
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Count one more request in the window (a retry inside a slot). */
  charge(): void {
    this.sent.push(this.now());
  }

  /** Pause every request (`overloaded`). */
  pause(ms: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
  }

  /** Requests counted in the current window (for logs and tests). */
  usedInWindow(): number {
    this.prune();
    return this.sent.length;
  }

  /** Drop every queued request: each rejects with `stopped`. */
  close(): void {
    this.closed = true;
    for (const wake of this.waits) wake();
    this.waits.clear();
  }

  private prune(): void {
    const floor = this.now() - HOUR_MS;
    while (this.sent.length > 0 && this.sent[0] <= floor) this.sent.shift();
  }

  private async slot(): Promise<void> {
    for (;;) {
      if (this.closed) throw new RenaultError("stopped", "the Renault integration is stopping");
      const now = this.now();
      if (this.pausedUntil > now) {
        await this.sleep(this.pausedUntil - now);
        continue;
      }
      this.prune();
      if (this.sent.length >= this.perHour) {
        await this.sleep(this.sent[0] + HOUR_MS - now);
        continue;
      }
      this.sent.push(now);
      return;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waits.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, ms));
      this.waits.add(done);
    });
  }
}
