import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kamereon } from "./api/kamereon.js";
import { RateLimiter } from "./api/rate.js";
import { Session } from "./api/session.js";
import { CapabilityMemory } from "./capabilities.js";
import type { Position } from "./mapping.js";
import { Scheduler } from "./scheduler.js";
import {
  fakeDeviceManager,
  FakeRenault,
  HOME_NEAR,
  recordingLogger,
  SENTINEL,
  type LoggedLine,
} from "./testing/world.testing.js";
import { sourceIdOf, Vehicle, type VehicleLink } from "./vehicle.js";

const RAFALE: VehicleLink = {
  vin: SENTINEL.vin,
  modelCode: "XHN1CP",
  label: "RAFALE",
  engine: "PHEV",
};
const MEGANE: VehicleLink = {
  vin: "VF1MEGANEVIN00777",
  modelCode: "XCB1VE",
  label: "MEGANE E-TECH",
  engine: "ELEC",
};
const OTHER: VehicleLink = {
  vin: "VF1OTHERVIN000888",
  modelCode: "ZZZ",
  label: "ZOE",
  engine: "ELEC",
};

function setup(link: VehicleLink = RAFALE, home: Position | null = HOME_NEAR) {
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
  const kamereon = new Kamereon(world.http, session, new RateLimiter({ perHour: 40 }), {
    url: "https://kam.test",
    apiKey: "kk",
    country: "FR",
  });
  let caps: string | undefined;
  const memory = new CapabilityMemory({ get: () => caps, set: (v) => (caps = v) });
  const deviceManager = fakeDeviceManager();
  const lines: LoggedLine[] = [];
  const health: boolean[] = [];
  const vehicle = new Vehicle(link, {
    integrationId: "renault",
    kamereon,
    accountId: "account-0001",
    deviceManager,
    logger: recordingLogger(lines),
    memory,
    home: () => home,
    homeRadiusM: 200,
    onHealth: (ok) => health.push(ok),
  });
  const scheduler = new Scheduler(() => {});
  const lastDeclared = () => {
    const call = deviceManager.upsertFromDiscovery.mock.calls.at(-1);
    if (!call) throw new Error("never declared");
    return call[2];
  };
  const published = () =>
    Object.assign({}, ...deviceManager.updateDeviceData.mock.calls.map((c) => c[2] as object));
  return {
    world,
    vehicle,
    deviceManager,
    lines,
    scheduler,
    memory,
    health,
    lastDeclared,
    published,
  };
}

describe("Vehicle declaration", () => {
  it("names the device with the model and the VIN's last four, never the VIN", () => {
    expect(sourceIdOf(RAFALE)).toBe("Rafale N042");
    expect(sourceIdOf(MEGANE)).toBe("Megane E-Tech 0777");
    const { vehicle, lastDeclared } = setup();
    vehicle.declare();
    expect(JSON.stringify(lastDeclared())).not.toContain(SENTINEL.vin);
  });

  it("publishes the contract categories, fuel extras for a PHEV, and no charge start on the Rafale", () => {
    const { vehicle } = setup();
    const d = vehicle.discovered();
    expect(Object.fromEntries(d.data.map((x) => [x.key, x.category]))).toEqual({
      battery_level: "ev_battery_level",
      range: "ev_range",
      plugged: "ev_plugged",
      charging_state: "ev_charging_state",
      reported_at: "ev_reported_at",
      at_home: "ev_at_home",
      mileage: "ev_mileage",
      fuel_range: "generic",
      fuel_quantity: "generic",
      charge_limit: "ev_charge_limit",
    });
    expect(Object.fromEntries(d.orders.map((x) => [x.key, x.category]))).toEqual({
      wake: "ev_wake",
      refresh: "ev_refresh",
      charge_limit: "set_ev_charge_limit",
    });
    expect(d.orders.find((o) => o.key === "charge_limit")).toMatchObject({ min: 55, max: 100 });
  });

  it("declares charge start on the Megane and on unknown models; no fuel on an electric car", () => {
    expect(
      setup(MEGANE)
        .vehicle.discovered()
        .orders.map((o) => o.key),
    ).toContain("charge_start");
    const other = setup(OTHER).vehicle.discovered();
    expect(other.orders.map((o) => o.key)).toContain("charge_start");
    expect(other.data.map((d) => d.key)).not.toContain("fuel_range");
  });

  it("does not declare at_home without a home position", () => {
    expect(
      setup(RAFALE, null)
        .vehicle.discovered()
        .data.map((d) => d.key),
    ).not.toContain("at_home");
  });
});

describe("Vehicle polls", () => {
  it("publishes the battery with the contract keys and the car's own report time", async () => {
    const { vehicle, deviceManager } = setup();
    await vehicle.pollBattery();
    const [integrationId, sourceId, payload] = deviceManager.updateDeviceData.mock.calls[0];
    expect(integrationId).toBe("renault");
    expect(sourceId).toBe("Rafale N042");
    expect(payload).toMatchObject({
      plugged: true,
      charging_state: "waiting",
      reported_at: "2026-10-03T15:09:36.000Z",
    });
    expect(typeof payload.battery_level).toBe("number");
    expect(deviceManager.updateDeviceStatus).toHaveBeenCalledWith(
      "renault",
      "Rafale N042",
      "online",
    );
  });

  it("publishes mileage, fuel, at_home and the charge limit — never coordinates", async () => {
    const { vehicle, published } = setup();
    await vehicle.pollCockpit();
    await vehicle.pollLocation();
    await vehicle.pollSoc();
    const p = published();
    expect(p).toMatchObject({ fuel_range: 305, fuel_quantity: 22, at_home: true });
    expect(typeof p.mileage).toBe("number");
    expect(typeof p.charge_limit).toBe("number");
    expect(JSON.stringify(p)).not.toContain(String(SENTINEL.lat));
  });

  it("reports at_home false when the car is away", async () => {
    const { vehicle, published } = setup(RAFALE, { lat: 46, lon: 5 });
    await vehicle.pollLocation();
    expect(published().at_home).toBe(false);
  });

  it("stops asking for a read Renault refuses for this car, and re-declares without it", async () => {
    const { world, vehicle, lastDeclared } = setup();
    world.error("GET", /cockpit$/, 403, "err.func.wired.forbidden");
    await vehicle.pollCockpit();
    await vehicle.pollCockpit();
    expect(world.count(/cockpit$/)).toBe(1);
    expect(lastDeclared().data.map((d) => d.key)).not.toContain("mileage");
  });

  it("never remembers a transient error as unsupported", async () => {
    const { world, vehicle, memory, deviceManager, health } = setup();
    world.on("GET", /battery-status$/, () => "network");
    await vehicle.pollBattery();
    await vehicle.pollBattery();
    expect(memory.isRefused("N042", "soc_read")).toBe(false);
    expect(deviceManager.updateDeviceStatus).toHaveBeenCalledWith(
      "renault",
      "Rafale N042",
      "offline",
    );
    expect(health).toContain(false);
  });

  it("logs a failing read once per kind", async () => {
    const { world, vehicle, lines } = setup();
    world.error("GET", /battery-status$/, 503, "err.tech.500");
    await vehicle.pollBattery();
    await vehicle.pollBattery();
    expect(lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });
});

describe("Vehicle orders", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("wake sends the lights action, then reads the battery 60 s later", async () => {
    const { world, vehicle, scheduler } = setup();
    await vehicle.wake(scheduler);
    const call = world.calls.find((c) => c.path.endsWith("actions/horn-lights"))!;
    expect(JSON.parse(call.body!)).toEqual({
      data: { type: "HornLights", attributes: { action: "start", target: "lights" } },
    });
    expect(world.count(/battery-status$/)).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.count(/battery-status$/)).toBe(1);
    scheduler.stop();
  });

  it("refresh reads the battery once and publishes it", async () => {
    const { world, vehicle, deviceManager } = setup();
    await vehicle.refresh();
    expect(world.count(/battery-status$/)).toBe(1);
    expect(deviceManager.updateDeviceData.mock.calls[0][2]).toMatchObject({
      charging_state: "waiting",
    });
    expect(world.count(/horn-lights$/)).toBe(0);
  });

  it("refresh rejects with a readable reason when Renault is unreachable", async () => {
    const { world, vehicle } = setup();
    world.on("GET", /battery-status$/, () => "network");
    await expect(vehicle.refresh()).rejects.toThrow("the Renault cloud cannot be reached");
  });

  it("charge_start on the Rafale is refused without calling Renault", async () => {
    const { world, vehicle, scheduler } = setup();
    await expect(vehicle.chargeStart(scheduler)).rejects.toThrow(
      "charge start is not allowed for this vehicle",
    );
    expect(world.count(/charging-start$/)).toBe(0);
  });

  it("charge_start forbidden on an unknown model: readable reason, order removed and remembered", async () => {
    const { world, vehicle, scheduler, memory, lastDeclared } = setup(OTHER);
    vehicle.declare();
    await expect(vehicle.chargeStart(scheduler)).rejects.toThrow(
      "charge start is not allowed for this vehicle",
    );
    expect(world.count(/charging-start$/)).toBe(1);
    expect(memory.isRefused("0888", "charge_start")).toBe(true);
    expect(lastDeclared().orders.map((o) => o.key)).not.toContain("charge_start");
    await expect(vehicle.chargeStart(scheduler)).rejects.toThrow("not allowed");
    expect(world.count(/charging-start$/)).toBe(1);
  });

  it("charge_start on the Megane goes through KCM", async () => {
    const { world, vehicle, scheduler } = setup(MEGANE);
    world.on("POST", /charge\/start$/, () => ({ status: 200, body: { data: {} } }));
    await vehicle.chargeStart(scheduler);
    expect(world.count(/kcm\/v1\/vehicles\/.*\/charge\/start$/, "POST")).toBe(1);
    scheduler.stop();
  });

  it("charge_limit 83 posts socTarget 85 and keeps socMin", async () => {
    const { world, vehicle, scheduler } = setup();
    await vehicle.pollSoc();
    await vehicle.setChargeLimit(83, scheduler);
    const post = world.calls.find((c) => c.method === "POST" && c.path.endsWith("ev/soc-levels"))!;
    const body = JSON.parse(post.body!) as { socMin: number; socTarget: number };
    expect(body.socTarget).toBe(85);
    expect(typeof body.socMin).toBe("number");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.count(/ev\/soc-levels$/, "GET")).toBe(2);
    scheduler.stop();
  });

  it("charge_limit reads the levels first when unknown, and refuses a non-number", async () => {
    const { world, vehicle, scheduler } = setup();
    await vehicle.setChargeLimit(80, scheduler);
    expect(world.count(/ev\/soc-levels$/, "GET")).toBe(1);
    await expect(vehicle.setChargeLimit("abc", scheduler)).rejects.toThrow("must be a number");
    scheduler.stop();
  });

  it("an action failure rejects with a readable reason, never a raw body", async () => {
    const { world, vehicle, scheduler } = setup();
    world.on("POST", /horn-lights$/, () => ({
      status: 500,
      body: { secret: SENTINEL.loginToken },
    }));
    const err = (await vehicle.wake(scheduler).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/Renault service error/);
    expect(err.message).not.toContain(SENTINEL.loginToken);
  });
});
