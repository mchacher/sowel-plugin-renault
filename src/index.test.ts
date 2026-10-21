import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlugin, INTEGRATION_ID } from "./index.js";
import { LOGIN_TOKEN_KEY, SETTINGS_PREFIX } from "./config.js";
import type { Device } from "./sowel-api.js";
import {
  fakeDeps,
  FakeRenault,
  fixture,
  HOME_NEAR,
  observable,
  SENTINEL,
} from "./testing/world.testing.js";

const CONFIGURED = {
  [`${SETTINGS_PREFIX}email`]: "owner@example.test",
  [`${SETTINGS_PREFIX}password`]: SENTINEL.password,
  "home.latitude": String(HOME_NEAR.lat),
  "home.longitude": String(HOME_NEAR.lon),
};

const device = (sourceDeviceId: string): Device => ({
  id: "d1",
  integrationId: INTEGRATION_ID,
  sourceDeviceId,
  name: sourceDeviceId,
});

function setup(settings: Record<string, string> = CONFIGURED) {
  const world = new FakeRenault();
  const ctx = fakeDeps(settings);
  const plugin = createPlugin(ctx.deps, world.http);
  return { world, plugin, ...ctx };
}

describe("RenaultPlugin", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("declares the renault identity and its settings", () => {
    const { plugin } = setup({});
    expect(plugin.id).toBe(INTEGRATION_ID);
    expect(plugin.apiVersion).toBe(2);
    const schema = plugin.getSettingsSchema();
    expect(schema.find((s) => s.key === "password")?.type).toBe("password");
    expect(schema.map((s) => s.key)).not.toContain("login_token");
  });

  it("stays not configured without e-mail and password", async () => {
    const { plugin } = setup({});
    expect(plugin.isConfigured()).toBe(false);
    await plugin.start();
    expect(plugin.getStatus()).toBe("not_configured");
  });

  it("connects, publishes the Rafale and polls it", async () => {
    const { plugin, world, deviceManager, events, store } = setup();
    await plugin.start();
    // Discovery, then the first polls, each on its own zero-delay timer.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(plugin.getStatus()).toBe("connected");
    expect(events).toContainEqual({
      type: "system.integration.connected",
      integrationId: "renault",
    });
    expect(store[LOGIN_TOKEN_KEY]).toBe(SENTINEL.loginToken);
    expect(deviceManager.upsertFromDiscovery).toHaveBeenCalled();
    expect(world.count(/battery-status$/)).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(world.count(/battery-status$/)).toBe(2);
    await plugin.stop();
    expect(plugin.getStatus()).toBe("disconnected");
  });

  it("a restart reuses the stored login token", async () => {
    const { plugin, world } = setup({ ...CONFIGURED, [LOGIN_TOKEN_KEY]: "stored-token" });
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.count(/accounts\.login$/)).toBe(0);
    await plugin.stop();
  });

  it("invalid credentials: error status, no retry storm", async () => {
    const { plugin, world } = setup();
    world.on("POST", /accounts\.login$/, () => ({ status: 200, body: { errorCode: 403042 } }));
    await plugin.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(plugin.getStatus()).toBe("error");
    expect(world.count(/accounts\.login$/)).toBe(1);
    await plugin.stop();
  });

  it("two-factor: error status and an alarm, no retry", async () => {
    const { plugin, world, events } = setup();
    world.on("POST", /accounts\.login$/, () => ({ status: 200, body: { errorCode: 403101 } }));
    await plugin.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(plugin.getStatus()).toBe("error");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "system.alarm.raised", alarmId: "renault.two-factor" }),
    );
    expect(world.count(/accounts\.login$/)).toBe(1);
    await plugin.stop();
  });

  it("a password rejected later, from a poll: error, polling stops, no login storm", async () => {
    const { plugin, world } = setup();
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(plugin.getStatus()).toBe("connected");
    // The login token expires and the password changed meanwhile.
    world.on("POST", /accounts\.getAccountInfo$/, () => ({
      status: 200,
      body: { errorCode: 403005 },
    }));
    world.on("POST", /accounts\.getJWT$/, () => ({ status: 200, body: { errorCode: 403005 } }));
    world.on("POST", /accounts\.login$/, () => ({ status: 200, body: { errorCode: 403042 } }));
    const logins = world.count(/accounts\.login$/);
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(plugin.getStatus()).toBe("error");
    expect(world.count(/accounts\.login$/) - logins).toBe(1);
    await plugin.stop();
  });

  it("stop during discovery leaves nothing running and no false connected", async () => {
    const { plugin, world, events, deviceManager } = setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    world.on("GET", /\/vehicles$/, async () => {
      await gate;
      return { status: 200, body: fixture("vehicles") };
    });
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(world.count(/\/vehicles$/)).toBe(1);
    await plugin.stop();
    release();
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(events).not.toContainEqual({
      type: "system.integration.connected",
      integrationId: "renault",
    });
    expect(deviceManager.upsertFromDiscovery).not.toHaveBeenCalled();
    expect(world.count(/battery-status$/)).toBe(0);
    expect(plugin.getStatus()).toBe("disconnected");
  });

  it("network failure: disconnected, retried with backoff", async () => {
    const { plugin, world } = setup();
    let down = true;
    world.on("POST", /accounts\.login$/, () =>
      down
        ? "network"
        : {
            status: 200,
            body: { errorCode: 0, sessionInfo: { cookieValue: SENTINEL.loginToken } },
          },
    );
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(plugin.getStatus()).toBe("disconnected");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.count(/accounts\.login$/)).toBe(2);
    down = false;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(plugin.getStatus()).toBe("connected");
    await plugin.stop();
  });

  it("declares itself a polling integration at the battery cadence", async () => {
    const { plugin } = setup();
    expect(plugin.getPollingInfo?.()).toBeNull();
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const info = plugin.getPollingInfo?.();
    expect(info?.intervalMs).toBe(10 * 60_000);
    expect(Date.parse(info!.lastPollAt)).toBeGreaterThan(0);
    await plugin.stop();
    expect(plugin.getPollingInfo?.()).toBeNull();
  });

  it("routes orders to the car and rejects unknown ones", async () => {
    const { plugin, world } = setup();
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    await plugin.executeOrder(device("Rafale N042"), "wake", null);
    expect(world.count(/horn-lights$/, "POST")).toBe(1);
    await expect(plugin.executeOrder(device("Rafale N042"), "honk", null)).rejects.toThrow(
      "unknown order",
    );
    await expect(plugin.executeOrder(device("Ghost 0000"), "wake", null)).rejects.toThrow(
      "not connected",
    );
    await plugin.stop();
  });

  it("never lets a secret, the VIN or a coordinate out (sentinels)", async () => {
    const { plugin, world, lines, events, deviceManager } = setup();
    const errors: unknown[] = [];
    // Every path: login, discovery, all polls, every order, failures.
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    const car = device("Rafale N042");
    await plugin.executeOrder(car, "wake", null);
    await plugin.executeOrder(car, "charge_limit", 83);
    await plugin.executeOrder(car, "charge_start", null).catch((e: unknown) => errors.push(e));
    world.on("POST", /horn-lights$/, () => ({ status: 500, body: { leak: SENTINEL.loginToken } }));
    await plugin.executeOrder(car, "wake", null).catch((e: unknown) => errors.push(e));
    world.error("GET", /battery-status$/, 401, "err.func.wired.unauthorized");
    const refreshed = plugin.refresh?.();
    // Repeated unauthorized pauses 15 min (throttling): let the clock run.
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    await refreshed;
    await plugin.stop();
    world.on("POST", /accounts\.login$/, () => ({ status: 200, body: { errorCode: 403042 } }));
    world.on("POST", /accounts\.getJWT$/, () => ({ status: 200, body: { errorCode: 403005 } }));
    await plugin.start();
    await vi.advanceTimersByTimeAsync(0);
    await plugin.stop();

    expect(errors).toHaveLength(2);
    const out = observable(
      lines,
      events,
      errors,
      deviceManager.upsertFromDiscovery.mock.calls,
      deviceManager.updateDeviceData.mock.calls,
      deviceManager.updateDeviceStatus.mock.calls,
      deviceManager.removeStaleDevices.mock.calls,
    );
    for (const secret of [
      SENTINEL.password,
      SENTINEL.loginToken,
      "SENTINELJWT",
      SENTINEL.vin,
      String(SENTINEL.lat),
      String(SENTINEL.lon),
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(lines.length).toBeGreaterThan(5);
  });
});

const MEGANE_VIN = "VF1MEGANE0000X123";
const TWO_ACCOUNTS = {
  ...CONFIGURED,
  [`${SETTINGS_PREFIX}email_2`]: "partner@example.test",
  [`${SETTINGS_PREFIX}password_2`]: "sentinel-pw-second-5521",
  [`${SETTINGS_PREFIX}account_label_2`]: "Megane",
};

/** The fake world with a second MyRenault login that owns a Megane E-Tech. */
function twoAccounts(world: FakeRenault) {
  const token = (c: { body?: string }, field: string) =>
    new URLSearchParams(c.body ?? "").get(field) ?? "";
  world.on("POST", /accounts\.login$/, (c) => ({
    status: 200,
    body: { errorCode: 0, sessionInfo: { cookieValue: `tok-${token(c, "loginID")}` } },
  }));
  world.on("POST", /accounts\.getAccountInfo$/, (c) => ({
    status: 200,
    body: {
      errorCode: 0,
      data: {
        personId: token(c, "login_token").includes("partner") ? "person-0002" : "person-0001",
      },
    },
  }));
  world.on("GET", /\/persons\/person-0002$/, () => ({
    status: 200,
    body: { accounts: [{ accountId: "account-0002", accountType: "MYRENAULT" }] },
  }));
  world.on("GET", /\/accounts\/account-0002\/vehicles$/, () => ({
    status: 200,
    body: {
      vehicleLinks: [
        {
          vin: MEGANE_VIN,
          vehicleDetails: {
            vin: MEGANE_VIN,
            engineEnergyType: "ELEC",
            model: { code: "XCB1VE", label: "MEGANE" },
          },
        },
      ],
    },
  }));
}

describe("RenaultPlugin with several accounts (spec 002)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("publishes the cars of both accounts, each with its own login token", async () => {
    const { plugin, world, deviceManager, store } = setup(TWO_ACCOUNTS);
    twoAccounts(world);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(plugin.getStatus()).toBe("connected");
    const names = deviceManager.upsertFromDiscovery.mock.calls.map((c) => c[2].friendlyName);
    expect(names).toEqual(expect.arrayContaining(["Rafale N042", "Megane X123"]));
    expect(store[LOGIN_TOKEN_KEY]).toBe("tok-owner@example.test");
    expect(store[`${SETTINGS_PREFIX}login_token_2`]).toBe("tok-partner@example.test");
    expect(deviceManager.removeStaleDevices).toHaveBeenCalledWith(
      "renault",
      new Set(["Rafale N042", "Megane X123"]),
    );
    await plugin.stop();
  });

  it("sends an order through the account that owns the car", async () => {
    const { plugin, world } = setup(TWO_ACCOUNTS);
    twoAccounts(world);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await plugin.executeOrder(device("Megane X123"), "wake", null);
    const wakes = world.calls.filter((c) => /horn-lights$/.test(c.path));
    expect(wakes).toHaveLength(1);
    expect(wakes[0].path).toContain("/accounts/account-0002/");
    await plugin.stop();
  });

  it("a second account with a wrong password leaves the first one running", async () => {
    const { plugin, world, deviceManager, events } = setup(TWO_ACCOUNTS);
    twoAccounts(world);
    world.on("POST", /accounts\.login$/, (c) =>
      new URLSearchParams(c.body ?? "").get("loginID") === "partner@example.test"
        ? { status: 200, body: { errorCode: 403042 } }
        : { status: 200, body: { errorCode: 0, sessionInfo: { cookieValue: "tok-owner" } } },
    );
    await plugin.start();
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(plugin.getStatus()).toBe("connected");
    expect(world.count(/battery-status$/)).toBeGreaterThan(1);
    expect(deviceManager.removeStaleDevices).not.toHaveBeenCalled();
    expect(events).not.toContainEqual({
      type: "system.integration.disconnected",
      integrationId: "renault",
    });
    await plugin.stop();
  });

  it("two-factor on the second account raises its own alarm", async () => {
    const { plugin, world, events } = setup(TWO_ACCOUNTS);
    twoAccounts(world);
    world.on("POST", /accounts\.login$/, (c) =>
      new URLSearchParams(c.body ?? "").get("loginID") === "partner@example.test"
        ? { status: 200, body: { errorCode: 403101 } }
        : { status: 200, body: { errorCode: 0, sessionInfo: { cookieValue: "tok-owner" } } },
    );
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "system.alarm.raised",
        alarmId: "renault.two-factor.2",
        message: expect.stringMatching(/^Megane: /),
      }),
    );
    await plugin.stop();
  });

  it("status is error only when every account is in error", async () => {
    const { plugin, world } = setup(TWO_ACCOUNTS);
    world.on("POST", /accounts\.login$/, () => ({ status: 200, body: { errorCode: 403042 } }));
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(plugin.getStatus()).toBe("error");
    await plugin.stop();
  });

  it("removes nothing while one account has not answered yet (cold start)", async () => {
    const { plugin, world, deviceManager } = setup(TWO_ACCOUNTS);
    twoAccounts(world);
    world.on("GET", /\/accounts\/account-0002\/vehicles$/, () => "network");
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deviceManager.removeStaleDevices).not.toHaveBeenCalled();
    await plugin.stop();
  });

  it("a car listed by both accounts is published once, by the first", async () => {
    const { plugin, world, deviceManager } = setup(TWO_ACCOUNTS);
    twoAccounts(world);
    world.ok("GET", /\/accounts\/account-0002\/vehicles$/, "vehicles");
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    const names = deviceManager.upsertFromDiscovery.mock.calls.map((c) => c[2].friendlyName);
    expect(names).toEqual(["Rafale N042"]);
    await plugin.stop();
  });

  it("an overloaded answer on one account does not pause the other", async () => {
    const { plugin, world } = setup(TWO_ACCOUNTS);
    twoAccounts(world);
    world.on("GET", /account-0002.*battery-status$/, () => ({
      status: 429,
      body: { errors: [{ errorCode: "err.func.wired.overloaded", errorMessage: "x" }] },
    }));
    await plugin.start();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    const own = world.calls.filter((c) => /account-0001.*battery-status$/.test(c.path));
    expect(own.length).toBeGreaterThanOrEqual(2);
    await plugin.stop();
  });

  it("emptying a slot drops its login token", async () => {
    const { plugin, store } = setup({
      ...CONFIGURED,
      [`${SETTINGS_PREFIX}login_token_2`]: "old-token",
    });
    await plugin.start();
    expect(store[`${SETTINGS_PREFIX}login_token_2`]).toBe("");
    await plugin.stop();
  });

  it("never lets any slot's e-mail or password out", async () => {
    const { plugin, world, lines, events, deviceManager } = setup(TWO_ACCOUNTS);
    twoAccounts(world);
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    world.on("POST", /accounts\.login$/, () => ({ status: 200, body: { errorCode: 403101 } }));
    world.on("POST", /accounts\.getJWT$/, () => ({ status: 200, body: { errorCode: 403005 } }));
    await plugin.stop();
    await plugin.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await plugin.stop();
    const out = observable(lines, events, deviceManager.upsertFromDiscovery.mock.calls);
    for (const secret of [
      "sentinel-pw-second-5521",
      SENTINEL.password,
      "partner@example.test",
      "owner@example.test",
      MEGANE_VIN,
    ])
      expect(out).not.toContain(secret);
    expect(lines.length).toBeGreaterThan(5);
  });
});
