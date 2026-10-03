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
