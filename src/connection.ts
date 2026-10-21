/**
 * One MyRenault login: its session, rate budget, cars, retry and failure state
 * (spec 002). A failure here is told to the plugin as a state change; it never
 * reaches another connection.
 */

import { Account } from "./account.js";
import { RenaultError } from "./api/errors.js";
import type { Http } from "./api/http.js";
import { Kamereon } from "./api/kamereon.js";
import { RateLimiter } from "./api/rate.js";
import { Session } from "./api/session.js";
import type { CapabilityMemory } from "./capabilities.js";
import {
  GIGYA_URL,
  KAMEREON_URL,
  loginTokenKey,
  readHome,
  type AccountSlot,
  type SharedConfig,
} from "./config.js";
import { Scheduler } from "./scheduler.js";
import type { Vehicle } from "./vehicle.js";
import type { PluginDeps } from "./sowel-api.js";

/** Renault's budget is about 60 per hour per account; stay well under (spec 001 FR8). */
export const REQUESTS_PER_HOUR = 40;
export const DISCOVERY_EVERY_MS = 24 * 3_600_000;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

export type ConnectionState = "disconnected" | "connected" | "error";

export interface ConnectionHooks {
  /** The state of this connection changed. */
  changed: () => void;
  /** This connection finished a complete discovery. */
  discovered: () => void;
  /** Discovery steps of all connections run one at a time (spec 002 FR9). */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Another connection already runs this car. */
  isOwned: (slot: number, sourceId: string) => boolean;
}

export interface ConnectionOptions {
  account: AccountSlot;
  shared: SharedConfig;
  deps: PluginDeps;
  http: Http;
  memory: CapabilityMemory;
  hooks: ConnectionHooks;
}

export class Connection {
  state: ConnectionState = "disconnected";
  /** Source ids published by the last complete discovery; null before the first. */
  lastDiscovery: Set<string> | null = null;
  lastPollAt: string | null = null;

  private readonly logger;
  private account: Account | null = null;
  private limiter: RateLimiter | null = null;
  private scheduler: Scheduler | null = null;
  private retryMs = RETRY_FIRST_MS;
  private lastFailure: string | null = null;
  private alarmRaised = false;

  constructor(private readonly o: ConnectionOptions) {
    this.logger = o.deps.logger.child({ module: "renault", account: o.account.label });
  }

  get slot(): number {
    return this.o.account.slot;
  }

  get size(): number {
    return this.account?.size ?? 0;
  }

  has(sourceId: string): boolean {
    return this.account?.has(sourceId) ?? false;
  }

  vehicle(sourceId: string): { vehicle: Vehicle; scheduler: Scheduler } | undefined {
    return this.account?.vehicle(sourceId);
  }

  async refreshBatteries(): Promise<void> {
    await this.account?.refreshBatteries();
  }

  start(): void {
    const { account: acc, shared, deps, http, memory } = this.o;
    const settings = deps.settingsManager;
    const tokenKey = loginTokenKey(acc.slot);
    // A token belongs to the e-mail it was issued for: a slot given another
    // login must not stay silently logged in as the old one. No marker yet
    // (settings of spec 001) adopts the stored token.
    const forKey = `${tokenKey}_for`;
    const owner = acc.email.toLowerCase();
    const issuedFor = settings.get(forKey);
    if (issuedFor && issuedFor !== owner) settings.set(tokenKey, "");
    if (issuedFor !== owner) settings.set(forKey, owner);
    const limiter = new RateLimiter({ perHour: REQUESTS_PER_HOUR });
    const session = new Session(
      http,
      {
        gigyaUrl: GIGYA_URL,
        gigyaApiKey: shared.gigyaApiKey,
        email: acc.email,
        password: acc.password,
      },
      {
        get: () => settings.get(tokenKey) || undefined,
        set: (token) => settings.set(tokenKey, token ?? ""),
      },
    );
    const kamereon = new Kamereon(http, session, limiter, {
      url: KAMEREON_URL,
      apiKey: shared.kamereonApiKey,
      country: shared.country,
    });
    session.onFatal = (err) => this.failed(err);
    this.limiter = limiter;
    this.scheduler = new Scheduler((err) => this.logger.error({ err }, "Renault task crashed"));
    this.account = new Account({
      integrationId: "renault",
      kamereon,
      session,
      deviceManager: deps.deviceManager,
      logger: this.logger,
      memory,
      home: () => readHome(settings),
      homeRadiusM: shared.homeRadiusM,
      onHealth: (ok) => this.setHealth(ok),
      isOwned: (id) => this.o.hooks.isOwned(acc.slot, id),
    });
    this.state = "disconnected";
    this.retryMs = RETRY_FIRST_MS;
    this.lastFailure = null;
    this.lastDiscovery = null;
    this.scheduler.after(0, () => this.connect());
  }

  /** Discover the cars; on failure, tell the kinds apart (spec 001 FR3). */
  private async connect(): Promise<void> {
    const account = this.account;
    const scheduler = this.scheduler;
    if (!account || !scheduler) return;
    try {
      const seen = await this.o.hooks.exclusive(() => this.discoverOnce(account));
      if (this.account !== account) return;
      this.lastDiscovery = seen;
      this.lastFailure = null;
      this.retryMs = RETRY_FIRST_MS;
      this.resolveAlarm();
      this.setState("connected");
      this.logger.info({ cars: account.size }, "Renault account connected");
      this.o.hooks.discovered();
      scheduler.after(DISCOVERY_EVERY_MS, () => this.connect());
    } catch (err) {
      const kind = err instanceof RenaultError ? err.kind : "unexpected";
      if (kind === "stopped" || this.account !== account) return;
      // Wrong credentials and two-factor were handled by `failed` (session onFatal).
      if (kind === "invalid_credentials" || kind === "two_factor") return;
      const message = err instanceof RenaultError ? err.message : "unexpected failure";
      this.failOnce(kind, message);
      this.setState(this.state === "connected" ? "connected" : "disconnected");
      scheduler.after(this.retryMs, () => this.connect());
      this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    }
  }

  /** A discovery queued behind another one may find its connection stopped meanwhile. */
  private async discoverOnce(account: Account): Promise<Set<string>> {
    if (this.account !== account)
      throw new RenaultError("stopped", "the Renault integration is stopping");
    const published = await account.discover();
    // Cars run by another account stay protected from the stale pass until they are taken over.
    return new Set([...published, ...account.skippedIds]);
  }

  /** Cars listed here but run elsewhere (spec 002 FR9). */
  get skippedIds(): ReadonlySet<string> {
    return this.account?.skippedIds ?? new Set();
  }

  /** Discover again now, once, without moving the 24 h cycle: a car changed hands. */
  async recheck(): Promise<void> {
    const account = this.account;
    if (!account) return;
    try {
      const seen = await this.o.hooks.exclusive(() => this.discoverOnce(account));
      if (this.account !== account) return;
      this.lastDiscovery = seen;
      this.o.hooks.discovered();
    } catch (err) {
      this.logger.debug({ err }, "Renault recheck failed, the next discovery retries");
    }
  }

  /**
   * The session failed for good (wrong credentials, two-factor), at connect or
   * later from a poll: stop this account's polling, report `error`. A restart
   * (settings save) starts over.
   */
  private failed(err: RenaultError): void {
    // A connection stopped meanwhile (settings saved) must not raise anything.
    if (!this.account) return;
    this.account?.stop();
    this.scheduler?.stop();
    if (err.kind === "invalid_credentials") {
      this.failOnce(err.kind, `${err.message} (or Renault changed its API key)`);
    } else {
      this.failOnce(err.kind, err.message);
      this.raiseAlarm(err.message);
    }
    this.setState("error");
  }

  private failOnce(kind: string, message: string): void {
    if (this.lastFailure === kind) {
      this.logger.debug({ kind }, "Renault connection still failing");
      return;
    }
    this.lastFailure = kind;
    this.logger.error({ kind, reason: message }, "Renault connection failed");
  }

  /** Reads reaching Renault (or not) after discovery. */
  private setHealth(ok: boolean): void {
    if (ok) this.lastPollAt = new Date().toISOString();
    if (this.state === "error") return;
    if (ok && this.lastFailure === null) this.setState("connected");
    else if (!ok) this.setState("disconnected");
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.o.hooks.changed();
  }

  private get alarmId(): string {
    return this.slot === 1 ? "renault.two-factor" : `renault.two-factor.${this.slot}`;
  }

  private raiseAlarm(message: string): void {
    if (this.alarmRaised) return;
    this.alarmRaised = true;
    this.o.deps.eventBus.emit({
      type: "system.alarm.raised",
      alarmId: this.alarmId,
      level: "error",
      source: "renault",
      message: `${this.o.account.label}: ${message}`,
    });
  }

  private resolveAlarm(): void {
    if (!this.alarmRaised) return;
    this.alarmRaised = false;
    this.o.deps.eventBus.emit({
      type: "system.alarm.resolved",
      alarmId: this.alarmId,
      source: "renault",
    });
  }

  stop(): void {
    this.resolveAlarm();
    this.scheduler?.stop();
    this.limiter?.close();
    this.account?.stop();
    this.scheduler = null;
    this.limiter = null;
    this.account = null;
    this.state = "disconnected";
  }
}
