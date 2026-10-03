import { describe, expect, it } from "vitest";
import { FakeRenault, SENTINEL, makeJwt } from "../testing/world.testing.js";
import { jwtExpiryMs, Session } from "./session.js";

function setup(stored?: string) {
  const world = new FakeRenault();
  let now = 1_800_000_000_000;
  world.now = () => now;
  let token = stored;
  const writes: (string | undefined)[] = [];
  const session = new Session(
    world.http,
    {
      gigyaUrl: "https://gigya.test",
      gigyaApiKey: "k",
      email: "a@b.c",
      password: SENTINEL.password,
    },
    {
      get: () => token,
      set: (t) => {
        token = t;
        writes.push(t);
      },
    },
    () => now,
  );
  return { world, session, writes, advance: (ms: number) => (now += ms), token: () => token };
}

describe("Session", () => {
  it("logs in with the password once and stores the login token", async () => {
    const { world, session, writes } = setup();
    await session.jwt();
    expect(world.count(/accounts\.login$/)).toBe(1);
    expect(world.count(/accounts\.getJWT$/)).toBe(1);
    expect(writes).toEqual([SENTINEL.loginToken]);
    expect(await session.personId()).toBe("person-0001");
  });

  it("reuses a stored login token without sending the password", async () => {
    const { world, session } = setup("stored-token");
    await session.jwt();
    expect(world.count(/accounts\.login$/)).toBe(0);
    expect(world.calls.some((c) => c.body?.includes(SENTINEL.password))).toBe(false);
  });

  it("serves the JWT from cache, then renews it a minute before expiry", async () => {
    const { world, session, advance } = setup();
    await session.jwt();
    await session.jwt();
    expect(world.count(/accounts\.getJWT$/)).toBe(1);
    advance(900_000 - 30_000);
    await session.jwt();
    expect(world.count(/accounts\.getJWT$/)).toBe(2);
    expect(world.count(/accounts\.login$/)).toBe(1);
  });

  it("shares one renewal between concurrent callers", async () => {
    const { world, session } = setup();
    await Promise.all([session.jwt(), session.jwt(), session.jwt()]);
    expect(world.count(/accounts\.getJWT$/)).toBe(1);
  });

  it("drops an expired login token and logs in again", async () => {
    const { world, session, token } = setup("old-token");
    world.on("POST", /accounts\.getAccountInfo$/, (c) =>
      c.body?.includes("old-token")
        ? { status: 200, body: { errorCode: 403005 } }
        : { status: 200, body: { errorCode: 0, data: { personId: "person-0001" } } },
    );
    await session.jwt();
    expect(world.count(/accounts\.login$/)).toBe(1);
    expect(token()).toBe(SENTINEL.loginToken);
  });

  it("raises two-factor without retrying", async () => {
    const { world, session } = setup();
    world.on("POST", /accounts\.login$/, () => ({ status: 200, body: { errorCode: 403101 } }));
    await expect(session.jwt()).rejects.toMatchObject({ kind: "two_factor" });
    expect(world.count(/accounts\.login$/)).toBe(1);
  });

  it("reports invalid credentials", async () => {
    const { world, session } = setup();
    world.on("POST", /accounts\.login$/, () => ({ status: 200, body: { errorCode: 403042 } }));
    await expect(session.jwt()).rejects.toMatchObject({ kind: "invalid_credentials" });
  });

  it("reports a network failure as network", async () => {
    const { world, session } = setup();
    world.on("POST", /accounts\.login$/, () => "network");
    await expect(session.jwt()).rejects.toMatchObject({ kind: "network" });
  });
});

describe("jwtExpiryMs", () => {
  it("decodes exp, and tolerates garbage", () => {
    expect(jwtExpiryMs(makeJwt(1_800_000_000_000))).toBe(1_800_000_000_000);
    expect(jwtExpiryMs("nope")).toBeNull();
  });
});
