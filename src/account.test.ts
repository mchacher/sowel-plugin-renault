import { describe, expect, it } from "vitest";
import { Account, electricLinks } from "./account.js";
import { Kamereon } from "./api/kamereon.js";
import { RateLimiter } from "./api/rate.js";
import { Session } from "./api/session.js";
import { CapabilityMemory } from "./capabilities.js";
import {
  fakeDeviceManager,
  FakeRenault,
  fixture,
  HOME_NEAR,
  recordingLogger,
  SENTINEL,
} from "./testing/world.testing.js";

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
  const kamereon = new Kamereon(world.http, session, new RateLimiter({ perHour: 40 }), {
    url: "https://kam.test",
    apiKey: "kk",
    country: "FR",
  });
  const deviceManager = fakeDeviceManager();
  const account = new Account({
    integrationId: "renault",
    kamereon,
    session,
    deviceManager,
    logger: recordingLogger([]),
    memory: new CapabilityMemory({ get: () => undefined, set: () => {} }),
    home: () => HOME_NEAR,
    homeRadiusM: 200,
    onHealth: () => {},
  });
  return { world, account, deviceManager };
}

const link = (vin: string, engine: string, energy = "GASLN", details = true) => ({
  vin,
  vehicleDetails: details
    ? {
        vin,
        engineEnergyType: engine,
        energy: { code: energy },
        model: { code: "X", label: "CAR" },
      }
    : undefined,
});

describe("electricLinks", () => {
  it("keeps ELEC, ELECX and PHEV, by engineEnergyType first", () => {
    const links = electricLinks({
      vehicleLinks: [
        link("V0000000000000001", "PHEV"),
        link("V0000000000000002", "ICE"),
        link("V0000000000000003", "ELEC", "ELEC"),
        link("V0000000000000004", "ELECX"),
        link("V0000000000000005", "PHEV", "GASLN", false),
      ],
    });
    expect(links.map((l) => l.vin.slice(-1))).toEqual(["1", "3", "4"]);
  });

  it("reads the recorded Rafale", () => {
    expect(electricLinks(fixture("vehicles"))).toEqual([
      { vin: SENTINEL.vin, modelCode: "XHN1CP", label: "RAFALE", engine: "PHEV" },
    ]);
  });
});

describe("Account.discover", () => {
  it("publishes the Rafale from the MyRenault account only", async () => {
    const { world, account, deviceManager } = setup();
    await account.discover();
    expect(account.size).toBe(1);
    expect(world.count(/account-other-1/)).toBe(0);
    expect(deviceManager.upsertFromDiscovery.mock.calls[0][2].friendlyName).toBe("Rafale N042");
    expect(deviceManager.removeStaleDevices).toHaveBeenCalledWith(
      "renault",
      new Set(["Rafale N042"]),
    );
    account.stop();
  });

  it("forgets a car removed from the account", async () => {
    const { world, account, deviceManager } = setup();
    await account.discover();
    world.on("GET", /\/accounts\/account-0001\/vehicles$/, () => ({
      status: 200,
      body: { vehicleLinks: [] },
    }));
    await account.discover();
    expect(account.size).toBe(0);
    expect(deviceManager.removeStaleDevices).toHaveBeenLastCalledWith("renault", new Set());
    account.stop();
  });

  it("removes nothing when discovery fails", async () => {
    const { world, account, deviceManager } = setup();
    world.on("GET", /\/vehicles$/, () => "network");
    await expect(account.discover()).rejects.toMatchObject({ kind: "network" });
    expect(deviceManager.removeStaleDevices).not.toHaveBeenCalled();
  });
});
