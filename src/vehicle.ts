/**
 * One car: what it publishes, how it is polled, and the orders it takes.
 *
 * The VIN is used in request paths and nowhere else: logs and the device name
 * carry the model label and the last four characters only.
 */

import { isUnsupported, orderFailureReason, RenaultError } from "./api/errors.js";
import type { Kamereon } from "./api/kamereon.js";
import type { CapabilityMemory, Feature } from "./capabilities.js";
import {
  atHomeOf,
  attributesOf,
  batteryPayload,
  CHARGE_LIMIT_MAX,
  CHARGE_LIMIT_MIN,
  chargeLimitTarget,
  cockpitPayload,
  EV_CHARGING_STATES,
  socLevelsOf,
  type EvChargingState,
  type Position,
  type SocLevels,
} from "./mapping.js";
import { capabilitiesOf } from "./models.js";
import type { Scheduler } from "./scheduler.js";
import type {
  DeviceManager,
  DiscoveredData,
  DiscoveredDevice,
  DiscoveredOrder,
  Logger,
} from "./sowel-api.js";

export const BATTERY_EVERY_MS = 10 * 60_000;
export const COCKPIT_EVERY_MS = 60 * 60_000;
export const LOCATION_EVERY_MS = 60 * 60_000;
/** A woken car reports within a minute; read it again then. */
export const AFTER_ACTION_READ_MS = 60_000;

export interface VehicleLink {
  vin: string;
  modelCode?: string;
  /** Model label as Renault gives it ("RAFALE"). */
  label: string;
  engine: string;
}

export interface VehicleContext {
  integrationId: string;
  kamereon: Kamereon;
  accountId: string;
  deviceManager: DeviceManager;
  logger: Logger;
  memory: CapabilityMemory;
  home: () => Position | null;
  homeRadiusM: number;
  /** A read reached Renault (true) or failed on the network (false). */
  onHealth: (ok: boolean) => void;
}

function titleCase(label: string): string {
  return label.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
}

/** `Rafale 1234`: readable, stable, unique enough, and no full VIN. */
export function sourceIdOf(link: VehicleLink): string {
  return `${titleCase(link.label || "Renault")} ${link.vin.slice(-4)}`;
}

const NOT_ALLOWED: Record<"charge_start" | "soc_write", string> = {
  charge_start: "charge start is not allowed for this vehicle",
  soc_write: "changing the charge limit is not allowed for this vehicle",
};

export class Vehicle {
  readonly sourceId: string;
  /** Key of the capability memory: the VIN's last four characters. */
  readonly car: string;
  private readonly logger: Logger;
  private chargingState: EvChargingState | null = null;
  private soc: SocLevels | null = null;
  private online: boolean | null = null;
  /** Last error kind per read, to log once per transition. */
  private readonly lastError = new Map<string, string>();

  constructor(
    private link: VehicleLink,
    private readonly ctx: VehicleContext,
  ) {
    this.sourceId = sourceIdOf(link);
    this.car = link.vin.slice(-4);
    this.logger = ctx.logger.child({ vehicle: this.sourceId });
  }

  /** A newer discovery of the same car (model label or engine may change). */
  update(link: VehicleLink): void {
    this.link = link;
  }

  private refused(feature: Feature): boolean {
    return this.ctx.memory.isRefused(this.car, feature);
  }

  private chargeStartRoute() {
    return this.refused("charge_start") ? null : capabilitiesOf(this.link.modelCode).chargeStart;
  }

  /** The device as the core sees it, from the model and what was refused. */
  discovered(): DiscoveredDevice {
    const data: DiscoveredData[] = [
      { key: "battery_level", type: "number", category: "ev_battery_level", unit: "%" },
      { key: "range", type: "number", category: "ev_range", unit: "km" },
      { key: "plugged", type: "boolean", category: "ev_plugged" },
      {
        key: "charging_state",
        type: "enum",
        category: "ev_charging_state",
        enumValues: [...EV_CHARGING_STATES],
      },
      { key: "reported_at", type: "string", category: "ev_reported_at" },
    ];
    if (this.ctx.home() && !this.refused("location"))
      data.push({ key: "at_home", type: "boolean", category: "ev_at_home" });
    if (!this.refused("cockpit")) {
      data.push({ key: "mileage", type: "number", category: "ev_mileage", unit: "km" });
      if (this.link.engine === "PHEV") {
        data.push({ key: "fuel_range", type: "number", category: "generic", unit: "km" });
        data.push({ key: "fuel_quantity", type: "number", category: "generic", unit: "L" });
      }
    }
    if (!this.refused("soc_read"))
      data.push({ key: "charge_limit", type: "number", category: "ev_charge_limit", unit: "%" });

    const orders: DiscoveredOrder[] = [
      { key: "wake", type: "boolean", category: "ev_wake" },
      // Core spec 184: read the latest report now (one request, never wakes the car).
      { key: "refresh", type: "boolean", category: "ev_refresh" },
    ];
    if (this.chargeStartRoute())
      orders.push({ key: "charge_start", type: "boolean", category: "ev_charge_start" });
    if (!this.refused("soc_read") && !this.refused("soc_write"))
      orders.push({
        key: "charge_limit",
        type: "number",
        category: "set_ev_charge_limit",
        min: CHARGE_LIMIT_MIN,
        max: CHARGE_LIMIT_MAX,
        unit: "%",
      });

    return {
      friendlyName: this.sourceId,
      manufacturer: "Renault",
      model: titleCase(this.link.label),
      powerSource: "mains",
      data,
      orders,
    };
  }

  declare(): void {
    this.ctx.deviceManager.upsertFromDiscovery(
      this.ctx.integrationId,
      "renault",
      this.discovered(),
    );
  }

  /** Register this car's polls on its scheduler. */
  schedule(scheduler: Scheduler): void {
    scheduler.every(BATTERY_EVERY_MS, () => this.pollBattery());
    scheduler.every(COCKPIT_EVERY_MS, () => this.pollCockpit());
    scheduler.every(LOCATION_EVERY_MS, () => this.pollLocation());
    scheduler.after(0, () => this.pollSoc());
  }

  private carPath(version: 1 | 2, endpoint: string): string {
    return `/accounts/${this.ctx.accountId}/kamereon/kca/car-adapter/v${version}/cars/${this.link.vin}/${endpoint}`;
  }

  private kcmPath(endpoint: string): string {
    return `/accounts/${this.ctx.accountId}/kamereon/kcm/v1/vehicles/${this.link.vin}/${endpoint}`;
  }

  private publish(payload: Record<string, unknown>): void {
    if (Object.keys(payload).length === 0) return;
    this.ctx.deviceManager.updateDeviceData(this.ctx.integrationId, this.sourceId, payload);
  }

  private setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.ctx.deviceManager.updateDeviceStatus(
      this.ctx.integrationId,
      this.sourceId,
      online ? "online" : "offline",
    );
  }

  /** A read answered: clear its error state. */
  private readOk(read: string): void {
    if (this.lastError.delete(read)) this.logger.info({ read }, "Renault read recovered");
    this.ctx.onHealth(true);
  }

  /**
   * A read failed. `forbidden`/`notFound` on an optional read is remembered
   * and the device re-declared without it; the rest is logged once per kind.
   */
  private readFailed(read: string, err: unknown, feature?: Feature): void {
    if (feature && isUnsupported(err)) {
      if (this.ctx.memory.refuse(this.car, feature)) {
        this.logger.info({ read }, "Renault does not offer this read for this vehicle; stopped");
        this.declare();
      }
      return;
    }
    const kind = err instanceof RenaultError ? err.kind : "unexpected";
    if (kind === "stopped") return;
    if (kind === "network") this.ctx.onHealth(false);
    if (this.lastError.get(read) !== kind) {
      this.lastError.set(read, kind);
      this.logger.warn(
        { read, kind, code: err instanceof RenaultError ? err.code : undefined },
        "Renault read failed",
      );
    }
  }

  async pollBattery(): Promise<void> {
    try {
      const attrs = attributesOf(await this.ctx.kamereon.get(this.carPath(2, "battery-status")));
      if (!attrs) return;
      const payload = batteryPayload(attrs, this.chargingState);
      if (typeof payload.charging_state === "string")
        this.chargingState = payload.charging_state as EvChargingState;
      this.publish(payload);
      this.setOnline(true);
      this.readOk("battery");
    } catch (err) {
      if (err instanceof RenaultError && err.kind === "network") this.setOnline(false);
      this.readFailed("battery", err);
    }
  }

  async pollCockpit(): Promise<void> {
    if (this.refused("cockpit")) return;
    try {
      const attrs = attributesOf(await this.ctx.kamereon.get(this.carPath(1, "cockpit")));
      if (attrs) this.publish(cockpitPayload(attrs));
      this.readOk("cockpit");
    } catch (err) {
      this.readFailed("cockpit", err, "cockpit");
    }
  }

  async pollLocation(): Promise<void> {
    const home = this.ctx.home();
    if (!home || this.refused("location")) return;
    try {
      const attrs = attributesOf(await this.ctx.kamereon.get(this.carPath(1, "location")));
      const atHome = attrs ? atHomeOf(attrs, home, this.ctx.homeRadiusM) : null;
      if (atHome !== null) this.publish({ at_home: atHome });
      this.readOk("location");
    } catch (err) {
      // Privacy mode can be switched off again: not remembered, just not published.
      this.readFailed("location", err, "location");
    }
  }

  async pollSoc(): Promise<void> {
    if (this.refused("soc_read")) return;
    try {
      const soc = socLevelsOf(await this.ctx.kamereon.get(this.kcmPath("ev/soc-levels")));
      if (soc) {
        this.soc = soc;
        this.publish({ charge_limit: soc.socTarget });
      }
      this.readOk("soc");
    } catch (err) {
      this.readFailed("soc", err, "soc_read");
    }
  }

  /** `wake`: the lights action wakes a sleeping car (measured on the Rafale). */
  async wake(scheduler: Scheduler): Promise<void> {
    await this.action("wake", () =>
      this.ctx.kamereon.post(this.carPath(1, "actions/horn-lights"), {
        data: { type: "HornLights", attributes: { action: "start", target: "lights" } },
      }),
    );
    scheduler.after(AFTER_ACTION_READ_MS, () => this.pollBattery());
  }

  /** `refresh`: one battery read now, through the budget. Rejects on failure. */
  async refresh(): Promise<void> {
    try {
      const attrs = attributesOf(await this.ctx.kamereon.get(this.carPath(2, "battery-status")));
      if (attrs) {
        const payload = batteryPayload(attrs, this.chargingState);
        if (typeof payload.charging_state === "string")
          this.chargingState = payload.charging_state as EvChargingState;
        this.publish(payload);
      }
      this.setOnline(true);
      this.readOk("battery");
    } catch (err) {
      // The cause is a RenaultError, rebuilt from codes: it carries no body.
      throw new Error(orderFailureReason(err), { cause: err });
    }
  }

  async chargeStart(scheduler: Scheduler): Promise<void> {
    const route = this.chargeStartRoute();
    if (!route) throw new Error(NOT_ALLOWED.charge_start);
    const path =
      route === "kcm" ? this.kcmPath("charge/start") : this.carPath(1, "actions/charging-start");
    await this.action(
      "charge_start",
      () =>
        this.ctx.kamereon.post(path, {
          data: { type: "ChargingStart", attributes: { action: "start" } },
        }),
      "charge_start",
    );
    scheduler.after(AFTER_ACTION_READ_MS, () => this.pollBattery());
  }

  /** POST soc-levels with the current `socMin` and the target rounded to 5. */
  async setChargeLimit(value: unknown, scheduler: Scheduler): Promise<void> {
    if (this.refused("soc_read") || this.refused("soc_write"))
      throw new Error(NOT_ALLOWED.soc_write);
    const target = chargeLimitTarget(value);
    if (target === null) throw new Error("the charge limit must be a number");
    if (!this.soc) await this.pollSoc();
    const soc = this.soc;
    if (!soc) throw new Error("the vehicle's charge levels cannot be read");
    await this.action(
      "charge_limit",
      () =>
        this.ctx.kamereon.post(this.kcmPath("ev/soc-levels"), {
          socMin: soc.socMin,
          socTarget: target,
        }),
      "soc_write",
    );
    scheduler.after(AFTER_ACTION_READ_MS, () => this.pollSoc());
  }

  /** Send an action; reject with a readable reason, never a raw body. */
  private async action(
    order: string,
    send: () => Promise<unknown>,
    feature?: "charge_start" | "soc_write",
  ): Promise<void> {
    try {
      await send();
      this.logger.info({ order }, "Renault action accepted");
    } catch (err) {
      const kind = err instanceof RenaultError ? err.kind : "unexpected";
      this.logger.warn(
        { order, kind, code: err instanceof RenaultError ? err.code : undefined },
        "Renault action refused",
      );
      if (feature && err instanceof RenaultError && err.kind === "forbidden") {
        if (this.ctx.memory.refuse(this.car, feature)) this.declare();
        throw new Error(NOT_ALLOWED[feature], { cause: err });
      }
      // The cause is a RenaultError, rebuilt from codes: it carries no body.
      throw new Error(orderFailureReason(err), { cause: err });
    }
  }
}
