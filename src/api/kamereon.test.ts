import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeRenault, SENTINEL } from "../testing/world.testing.js";
import { Kamereon } from "./kamereon.js";
import { RateLimiter } from "./rate.js";
import { Session } from "./session.js";

function setup() {
  const world = new FakeRenault();
  const session = new Session(
    world.http,
    {
      gigyaUrl: "https://gigya.test",
      gigyaApiKey: "k",
      email: "a@b.c",
      password: SENTINEL.password,
    },
    { get: () => "stored", set: () => {} },
  );
  const limiter = new RateLimiter({ perHour: 40 });
  const kamereon = new Kamereon(world.http, session, limiter, {
    url: "https://kam.test",
    apiKey: "kk",
    country: "FR",
  });
  return { world, kamereon, limiter };
}

describe("Kamereon", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the Kamereon headers and the country", async () => {
    const { world, kamereon } = setup();
    await kamereon.get("/persons/person-0001");
    const call = world.calls.find((c) => c.path.endsWith("/persons/person-0001"))!;
    expect(call.url).toContain("country=FR");
    expect(call.headers.apikey).toBe("kk");
    expect(call.headers["x-gigya-id_token"]).toContain("SENTINELJWT");
  });

  it("renews the JWT once on unauthorized and retries once", async () => {
    const { world, kamereon } = setup();
    let first = true;
    world.on("GET", /\/persons\/person-0001$/, () => {
      if (first) {
        first = false;
        return { status: 401, body: { errors: [{ errorCode: "err.func.wired.unauthorized" }] } };
      }
      return { status: 200, body: { accounts: [] } };
    });
    await expect(kamereon.get("/persons/person-0001")).resolves.toEqual({ accounts: [] });
    expect(world.count(/accounts\.getJWT$/)).toBe(2);
  });

  it("gives up after a second unauthorized", async () => {
    const { world, kamereon } = setup();
    world.error("GET", /\/persons\//, 401, "err.func.wired.unauthorized");
    await expect(kamereon.get("/persons/person-0001")).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(world.count(/\/persons\//)).toBe(2);
  });

  it("counts the retry against the budget and backs off after a second unauthorized", async () => {
    const { world, kamereon, limiter } = setup();
    world.error("GET", /\/persons\//, 401, "err.func.wired.unauthorized");
    await expect(kamereon.get("/persons/person-0001")).rejects.toMatchObject({
      kind: "unauthorized",
    });
    expect(limiter.usedInWindow()).toBe(2);
    let done = false;
    const next = kamereon.get("/accounts/account-0001/vehicles").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await next;
    expect(done).toBe(true);
  });

  it("pauses all requests 15 min on overloaded", async () => {
    const { world, kamereon } = setup();
    world.error("GET", /\/persons\//, 429, "err.func.wired.overloaded");
    await expect(kamereon.get("/persons/person-0001")).rejects.toMatchObject({
      kind: "overloaded",
    });
    let done = false;
    const next = kamereon.get("/accounts/account-0001/vehicles").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    await next;
    expect(done).toBe(true);
  });

  it("turns a fetch failure into a network error", async () => {
    const { world, kamereon } = setup();
    world.on("GET", /\/persons\//, () => "network");
    await expect(kamereon.get("/persons/person-0001")).rejects.toMatchObject({ kind: "network" });
  });
});
