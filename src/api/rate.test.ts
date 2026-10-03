import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "./rate.js";

describe("RateLimiter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs one request at a time, in order", async () => {
    const limiter = new RateLimiter({ perHour: 40 });
    const order: string[] = [];
    let release!: () => void;
    const first = limiter.run(
      () =>
        new Promise<void>((r) => {
          order.push("a-start");
          release = () => {
            order.push("a-end");
            r();
          };
        }),
    );
    const second = limiter.run(async () => {
      order.push("b");
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["a-start"]);
    release();
    await first;
    await second;
    expect(order).toEqual(["a-start", "a-end", "b"]);
  });

  it("makes the 41st request of the hour wait until the oldest leaves the window", async () => {
    const limiter = new RateLimiter({ perHour: 40 });
    for (let i = 0; i < 40; i++) await limiter.run(async () => undefined);
    let done = false;
    const late = limiter.run(async () => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await late;
    expect(done).toBe(true);
    // The first 40 all left the window together; only the late one counts.
    expect(limiter.usedInWindow()).toBe(1);
  });

  it("pauses every request after overloaded", async () => {
    const limiter = new RateLimiter({ perHour: 40 });
    limiter.pause(15 * 60_000);
    let done = false;
    const p = limiter.run(async () => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    expect(done).toBe(true);
  });

  it("keeps going after a failed request", async () => {
    const limiter = new RateLimiter({ perHour: 40 });
    await expect(limiter.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(limiter.run(async () => 7)).resolves.toBe(7);
  });

  it("drops queued work on close", async () => {
    const limiter = new RateLimiter({ perHour: 1 });
    await limiter.run(async () => undefined);
    const waiting = limiter.run(async () => "never");
    const assertion = expect(waiting).rejects.toMatchObject({ kind: "stopped" });
    limiter.close();
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });
});
