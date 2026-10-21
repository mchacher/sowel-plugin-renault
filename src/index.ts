/**
 * Sowel plugin: Renault
 *
 * Renault cars through the MyRenault cloud, each published as a device
 * carrying the electric vehicle contract of core spec 183 (spec 001). Up to
 * three MyRenault logins run side by side (spec 002).
 */

import { fetchHttp, type Http } from "./api/http.js";
import { CapabilityMemory } from "./capabilities.js";
import { Connection, DISCOVERY_EVERY_MS, REQUESTS_PER_HOUR } from "./connection.js";
import {
  ACCOUNT_SLOTS,
  CAPABILITIES_KEY,
  isConfigured,
  loginTokenKey,
  readConfig,
  SETTINGS_SCHEMA,
} from "./config.js";
import { BATTERY_EVERY_MS } from "./vehicle.js";
import type {
  Device,
  IntegrationPlugin,
  IntegrationSettingDef,
  IntegrationStatus,
  Logger,
  PluginDeps,
} from "./sowel-api.js";

export const INTEGRATION_ID = "renault";
export { DISCOVERY_EVERY_MS, REQUESTS_PER_HOUR };

class RenaultPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Renault";
  readonly description =
    "Renault cars through the MyRenault cloud: battery level, range, charging state, and a remote wake";
  readonly icon = "Car";
  readonly apiVersion = 2;

  private readonly logger: Logger;
  private status: IntegrationStatus = "not_configured";
  private connections: Connection[] = [];
  /** Discovery steps wait for the one before (a car is published by one account). */
  private discoveryTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly deps: PluginDeps,
    private readonly http: Http,
  ) {
    this.logger = deps.logger.child({ module: "renault" });
  }

  getStatus(): IntegrationStatus {
    return this.status;
  }

  isConfigured(): boolean {
    return isConfigured(this.deps.settingsManager);
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return SETTINGS_SCHEMA;
  }

  async start(): Promise<void> {
    await this.stop();
    const settings = this.deps.settingsManager;
    const cfg = readConfig(settings);
    if (!cfg) {
      this.status = "not_configured";
      return;
    }
    for (const slot of cfg.incomplete)
      this.logger.warn({ slot }, "Renault account ignored: e-mail and password are both needed");
    // A slot that was emptied must not keep a login token that would come back to life.
    const active = new Set(cfg.accounts.map((a) => a.slot));
    for (const slot of ACCOUNT_SLOTS)
      if (!active.has(slot) && settings.get(loginTokenKey(slot)))
        settings.set(loginTokenKey(slot), "");

    const memory = new CapabilityMemory({
      get: () => settings.get(CAPABILITIES_KEY),
      set: (v) => settings.set(CAPABILITIES_KEY, v),
    });
    this.status = "disconnected";
    this.connections = cfg.accounts.map(
      (account) =>
        new Connection({
          account,
          shared: cfg.shared,
          deps: this.deps,
          http: this.http,
          memory,
          hooks: {
            changed: () => this.updateStatus(),
            discovered: () => this.removeStaleDevices(),
            exclusive: (fn) => this.exclusive(fn),
            isOwned: (slot, id) => this.connections.some((c) => c.slot !== slot && c.has(id)),
          },
        }),
    );
    for (const c of this.connections) c.start();
    this.logger.info(
      { locale: cfg.shared.locale, accounts: this.connections.length },
      "Renault plugin started",
    );
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.discoveryTail.then(fn);
    this.discoveryTail = run.catch(() => undefined);
    return run;
  }

  /** The integration status follows its connections: any connected, else all in error. */
  private updateStatus(): void {
    if (this.connections.length === 0) return;
    const states = this.connections.map((c) => c.state);
    const next: IntegrationStatus = states.includes("connected")
      ? "connected"
      : states.every((s) => s === "error")
        ? "error"
        : "disconnected";
    this.setStatus(next);
  }

  /**
   * Cars that left their account are removed only when every account has
   * answered at least once: a cold start with one account down must not purge
   * its cars (spec 002 FR8).
   */
  private removeStaleDevices(): void {
    const rounds = this.connections.map((c) => c.lastDiscovery);
    if (rounds.some((r) => r === null)) return;
    const union = new Set<string>();
    for (const r of rounds) for (const id of r ?? []) union.add(id);
    this.deps.deviceManager.removeStaleDevices(INTEGRATION_ID, union);
  }

  /**
   * A car reports a minute or more after an order (charge limit): with the
   * battery cadence declared, the core waits 20 min before calling an order
   * unconfirmed instead of its default 30 s.
   */
  getPollingInfo(): { lastPollAt: string; intervalMs: number } | null {
    if (this.connections.length === 0) return null;
    const last = this.connections
      .map((c) => c.lastPollAt)
      .filter((t): t is string => t !== null)
      .sort()
      .at(-1);
    return {
      lastPollAt: last ?? new Date(0).toISOString(),
      intervalMs: BATTERY_EVERY_MS,
    };
  }

  private setStatus(status: IntegrationStatus): void {
    if (this.status === status) return;
    const was = this.status;
    this.status = status;
    if (status === "connected")
      this.deps.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
    else if (was === "connected")
      this.deps.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
  }

  async stop(): Promise<void> {
    for (const c of this.connections) c.stop();
    this.connections = [];
    if (this.status !== "not_configured") this.setStatus("disconnected");
  }

  async refresh(): Promise<void> {
    // Reads are budgeted: one battery read per car, per account.
    await Promise.all(this.connections.map((c) => c.refreshBatteries()));
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    const entry = this.connections
      .map((c) => c.vehicle(device.sourceDeviceId))
      .find((e) => e !== undefined);
    if (!entry) throw new Error("this vehicle is not connected");
    const { vehicle, scheduler } = entry;
    switch (orderKey) {
      case "wake":
        return vehicle.wake(scheduler);
      case "charge_start":
        return vehicle.chargeStart(scheduler);
      case "charge_limit":
        return vehicle.setChargeLimit(value, scheduler);
      case "refresh":
        return vehicle.refresh();
      default:
        throw new Error(`unknown order "${orderKey}"`);
    }
  }
}

export function createPlugin(deps: PluginDeps, http: Http = fetchHttp): IntegrationPlugin {
  return new RenaultPlugin(deps, http);
}
