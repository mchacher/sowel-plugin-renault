import { describe, expect, it } from "vitest";
import {
  atHomeOf,
  batteryPayload,
  chargeLimitTarget,
  chargingStateOf,
  cockpitPayload,
  isoUtc,
  pluggedOf,
  socLevelsOf,
} from "./mapping.js";

describe("chargingStateOf", () => {
  it.each([
    [1, 1.0, "charging"],
    [1, -1.6, "charging"],
    [1, 0.2, "completed"],
    [1, 0.1, "scheduled"],
    [1, 0.3, "waiting"],
    [1, -1.3, "waiting"],
    [1, -1.0, "error"],
    [1, 0.0, "idle"],
    [1, -1.4, "idle"],
    [1, -1.5, "idle"],
    [0, 0.0, "unplugged"],
    [0, 1.0, "unplugged"],
    [1, 0.4, "unplugged"],
    [-1, 0.0, "error"],
  ])("plugStatus %s, chargingStatus %s → %s", (plug, cs, expected) => {
    expect(chargingStateOf(plug, cs, null)).toBe(expected);
  });

  it("keeps the previous state on an uninformative code", () => {
    expect(chargingStateOf(1, -1.1, "charging")).toBe("charging");
    expect(chargingStateOf(1, 7.7, "waiting")).toBe("waiting");
    expect(chargingStateOf(undefined, undefined, null)).toBeNull();
  });
});

describe("pluggedOf", () => {
  it("reads plugStatus, else infers from chargingStatus", () => {
    expect(pluggedOf(1, 0)).toBe(true);
    expect(pluggedOf(0, 1)).toBe(false);
    expect(pluggedOf(undefined, 0.3)).toBe(true);
    expect(pluggedOf(undefined, 0.0)).toBeNull();
  });
});

describe("isoUtc", () => {
  it("normalises offsets and Z to ISO UTC", () => {
    expect(isoUtc("2026-10-03T17:09:36+02:00")).toBe("2026-10-03T15:09:36.000Z");
    expect(isoUtc("2026-10-03T15:09:36Z")).toBe("2026-10-03T15:09:36.000Z");
    expect(isoUtc("nope")).toBeNull();
    expect(isoUtc(undefined)).toBeNull();
  });
});

describe("atHomeOf", () => {
  const home = { lat: 45, lon: 5 };
  // 0.00135° of latitude ≈ 150 m; 0.00315° ≈ 350 m.
  it("is true within the radius, false beyond, and never returns a position", () => {
    const near = atHomeOf({ gpsLatitude: 45.00135, gpsLongitude: 5 }, home, 200);
    const far = atHomeOf({ gpsLatitude: 45.00315, gpsLongitude: 5 }, home, 200);
    expect(near).toBe(true);
    expect(far).toBe(false);
  });

  it("is null without a home position or without coordinates", () => {
    expect(atHomeOf({ gpsLatitude: 45, gpsLongitude: 5 }, null, 200)).toBeNull();
    expect(atHomeOf({}, home, 200)).toBeNull();
  });
});

describe("payloads", () => {
  it("maps battery-status to the contract keys", () => {
    expect(
      batteryPayload(
        {
          batteryLevel: 8,
          batteryAutonomy: 4,
          plugStatus: 1,
          chargingStatus: 0.3,
          timestamp: "2026-10-03T15:09:36Z",
        },
        null,
      ),
    ).toEqual({
      battery_level: 8,
      range: 4,
      plugged: true,
      charging_state: "waiting",
      reported_at: "2026-10-03T15:09:36.000Z",
    });
  });

  it("omits what Renault does not send", () => {
    expect(batteryPayload({}, null)).toEqual({});
  });

  it("maps cockpit to mileage and fuel extras", () => {
    expect(cockpitPayload({ totalMileage: 1234, fuelAutonomy: 305, fuelQuantity: 22 })).toEqual({
      mileage: 1234,
      fuel_range: 305,
      fuel_quantity: 22,
    });
  });

  it("reads soc-levels, which is not wrapped in data", () => {
    expect(socLevelsOf({ socMin: 15, socTarget: 80 })).toEqual({ socMin: 15, socTarget: 80 });
    expect(socLevelsOf({ socMin: 15 })).toBeNull();
  });
});

describe("chargeLimitTarget", () => {
  it("rounds to 5 within 55–100", () => {
    expect(chargeLimitTarget(83)).toBe(85);
    expect(chargeLimitTarget(82)).toBe(80);
    expect(chargeLimitTarget(20)).toBe(55);
    expect(chargeLimitTarget(120)).toBe(100);
    expect(chargeLimitTarget("90")).toBe(90);
    expect(chargeLimitTarget("x")).toBeNull();
    expect(chargeLimitTarget(null)).toBeNull();
  });
});
