/**
 * Sowel plugin: Renault
 *
 * Renault cars through the MyRenault cloud, each published as a device
 * carrying the electric vehicle contract of core spec 183 (spec 001).
 */

import { Account } from "./account.js";
import { RenaultError } from "./api/errors.js";
import { fetchHttp, type Http } from "./api/http.js";
import { Kamereon } from "./api/kamereon.js";
import { RateLimiter } from "./api/rate.js";
import { Session } from "./api/session.js";
import { CapabilityMemory } from "./capabilities.js";
import {
  CAPABILITIES_KEY,
  GIGYA_URL,
  isConfigured,
  KAMEREON_URL,
  LOGIN_TOKEN_KEY,
  readConfig,
  readHome,
  SETTINGS_SCHEMA,
} from "./config.js";
import { Scheduler } from "./scheduler.js";
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

/** Renault's budget is about 60 per hour; stay well under (spec 001 FR8). */
export const REQUESTS_PER_HOUR = 40;
export const DISCOVERY_EVERY_MS = 24 * 3_600_000;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const TWO_FACTOR_ALARM = "renault.two-factor";

class RenaultPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Renault";
  readonly description =
    "Renault cars through the MyRenault cloud: battery level, range, charging state, and a remote wake";
  readonly icon = "Car";
  readonly apiVersion = 2;

  private readonly logger: Logger;
  private status: IntegrationStatus = "not_configured";
  private account: Account | null = null;
  private limiter: RateLimiter | null = null;
  private scheduler: Scheduler | null = null;
  private retryMs = RETRY_FIRST_MS;
  private alarmRaised = false;
  private lastFailure: string | null = null;
  private lastPollAt: string | null = null;

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
    const cfg = readConfig(this.deps.settingsManager);
    if (!cfg) {
      this.status = "not_configured";
      return;
    }
    const settings = this.deps.settingsManager;
    const limiter = new RateLimiter({ perHour: REQUESTS_PER_HOUR });
    const session = new Session(
      this.http,
      {
        gigyaUrl: GIGYA_URL,
        gigyaApiKey: cfg.gigyaApiKey,
        email: cfg.email,
        password: cfg.password,
      },
      {
        get: () => settings.get(LOGIN_TOKEN_KEY) || undefined,
        set: (token) => settings.set(LOGIN_TOKEN_KEY, token ?? ""),
      },
    );
    const kamereon = new Kamereon(this.http, session, limiter, {
      url: KAMEREON_URL,
      apiKey: cfg.kamereonApiKey,
      country: cfg.country,
    });
    const memory = new CapabilityMemory({
      get: () => settings.get(CAPABILITIES_KEY),
      set: (v) => settings.set(CAPABILITIES_KEY, v),
    });
    session.onFatal = (err) => this.failed(err);
    this.limiter = limiter;
    this.scheduler = new Scheduler((err) => this.logger.error({ err }, "Renault task crashed"));
    this.account = new Account({
      integrationId: INTEGRATION_ID,
      kamereon,
      session,
      deviceManager: this.deps.deviceManager,
      logger: this.logger,
      memory,
      home: () => readHome(settings),
      homeRadiusM: cfg.homeRadiusM,
      onHealth: (ok) => this.setHealth(ok),
    });
    this.status = "disconnected";
    this.retryMs = RETRY_FIRST_MS;
    this.lastFailure = null;
    this.scheduler.after(0, () => this.connect());
    this.logger.info({ locale: cfg.locale }, "Renault plugin started");
  }

  /** Discover the cars; on failure, tell the kinds apart (FR3). */
  private async connect(): Promise<void> {
    const account = this.account;
    const scheduler = this.scheduler;
    if (!account || !scheduler) return;
    try {
      await account.discover();
      if (this.account !== account) return;
      this.lastFailure = null;
      this.retryMs = RETRY_FIRST_MS;
      this.resolveAlarm();
      this.setStatus("connected");
      this.logger.info({ cars: account.size }, "Renault account connected");
      scheduler.after(DISCOVERY_EVERY_MS, () => this.connect());
    } catch (err) {
      const kind = err instanceof RenaultError ? err.kind : "unexpected";
      if (kind === "stopped" || this.account !== account) return;
      // Wrong credentials and two-factor were handled by `failed` (session onFatal).
      if (kind === "invalid_credentials" || kind === "two_factor") return;
      const message = err instanceof RenaultError ? err.message : "unexpected failure";
      this.failOnce(kind, message);
      this.setStatus(this.status === "connected" ? "connected" : "disconnected");
      scheduler.after(this.retryMs, () => this.connect());
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    }
  }

  /**
   * The session failed for good (wrong credentials, two-factor), at connect or
   * later from a poll: stop polling, report `error`. A restart (settings save)
   * starts over.
   */
  private failed(err: RenaultError): void {
    this.account?.stop();
    this.scheduler?.stop();
    if (err.kind === "invalid_credentials") {
      this.failOnce(err.kind, `${err.message} (or Renault changed its API key)`);
    } else {
      this.failOnce(err.kind, err.message);
      this.raiseAlarm(err.message);
    }
    this.setStatus("error");
  }

  private failOnce(kind: string, message: string): void {
    if (this.lastFailure === kind) {
      this.logger.debug({ kind }, "Renault connection still failing");
      return;
    }
    this.lastFailure = kind;
    this.logger.error({ kind, reason: message }, "Renault connection failed");
  }

  /**
   * A car reports a minute or more after an order (charge limit): with the
   * battery cadence declared, the core waits 20 min before calling an order
   * unconfirmed instead of its default 30 s.
   */
  getPollingInfo(): { lastPollAt: string; intervalMs: number } | null {
    if (!this.account) return null;
    return {
      lastPollAt: this.lastPollAt ?? new Date(0).toISOString(),
      intervalMs: BATTERY_EVERY_MS,
    };
  }

  /** Reads reaching Renault (or not) after discovery. */
  private setHealth(ok: boolean): void {
    if (ok) this.lastPollAt = new Date().toISOString();
    if (this.status === "error" || this.status === "not_configured") return;
    if (ok && this.lastFailure === null) this.setStatus("connected");
    else if (!ok) this.setStatus("disconnected");
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

  private raiseAlarm(message: string): void {
    if (this.alarmRaised) return;
    this.alarmRaised = true;
    this.deps.eventBus.emit({
      type: "system.alarm.raised",
      alarmId: TWO_FACTOR_ALARM,
      level: "error",
      source: this.id,
      message,
    });
  }

  private resolveAlarm(): void {
    if (!this.alarmRaised) return;
    this.alarmRaised = false;
    this.deps.eventBus.emit({
      type: "system.alarm.resolved",
      alarmId: TWO_FACTOR_ALARM,
      source: this.id,
    });
  }

  async stop(): Promise<void> {
    this.scheduler?.stop();
    this.limiter?.close();
    this.account?.stop();
    this.scheduler = null;
    this.limiter = null;
    this.account = null;
    if (this.status !== "not_configured") this.setStatus("disconnected");
  }

  async refresh(): Promise<void> {
    // Nothing to read when stopped; reads are budgeted, so one battery read per car.
    const account = this.account;
    if (!account) return;
    await account.refreshBatteries();
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    const entry = this.account?.vehicle(device.sourceDeviceId);
    if (!entry) throw new Error("this vehicle is not connected");
    const { vehicle, scheduler } = entry;
    switch (orderKey) {
      case "wake":
        return vehicle.wake(scheduler);
      case "charge_start":
        return vehicle.chargeStart(scheduler);
      case "charge_limit":
        return vehicle.setChargeLimit(value, scheduler);
      default:
        throw new Error(`unknown order "${orderKey}"`);
    }
  }
}

export function createPlugin(deps: PluginDeps, http: Http = fetchHttp): IntegrationPlugin {
  return new RenaultPlugin(deps, http);
}
