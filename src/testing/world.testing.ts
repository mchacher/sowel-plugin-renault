/**
 * A fake MyRenault for tests: Gigya and Kamereon routes answered from the
 * recorded fixtures (scrubbed), with sentinel secrets that tests can look for.
 */

import { readFileSync } from "node:fs";
import { vi } from "vitest";
import type { Http, HttpRequest } from "../api/http.js";
import type { DeviceManager, Logger, PluginDeps } from "../sowel-api.js";

// Built from parts so no secret-shaped literal sits in the source.
export const SENTINEL = {
  password: ["sentinel", "pw", "7731"].join("-"),
  loginToken: ["SENTINEL", "LOGIN", "TOKEN", "7731"].join("_"),
  vin: "VF1SENTINELVIN042",
  lat: 45.123456,
  lon: 5.654321,
} as const;

/** Home, 40 m from the car's sentinel position. */
export const HOME_NEAR = { lat: 45.12382, lon: 5.654321 };

export function fixture(name: string): unknown {
  const raw = readFileSync(new URL(`../__fixtures__/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(raw.replaceAll("VF1TESTVIN0000000", SENTINEL.vin)) as unknown;
}

/** A JWT whose `exp` is `expMs`; the signature part carries a sentinel. */
export function makeJwt(expMs: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc({ exp: Math.floor(expMs / 1000) })}.SENTINELJWTSIGNATURE`;
}

export interface Call {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Reply = { status: number; body: unknown } | "network";

export class FakeRenault {
  readonly calls: Call[] = [];
  private readonly routes: {
    method: string;
    match: RegExp;
    reply: (c: Call) => Reply | Promise<Reply>;
  }[] = [];
  now: () => number = Date.now;

  constructor() {
    this.on("POST", /accounts\.login$/, () => ({
      status: 200,
      body: { errorCode: 0, sessionInfo: { cookieValue: SENTINEL.loginToken } },
    }));
    this.on("POST", /accounts\.getAccountInfo$/, () => ({
      status: 200,
      body: { errorCode: 0, data: { personId: "person-0001" } },
    }));
    this.on("POST", /accounts\.getJWT$/, () => ({
      status: 200,
      body: { errorCode: 0, id_token: makeJwt(this.now() + 900_000) },
    }));
    this.ok("GET", /\/persons\/person-0001$/, "person");
    this.ok("GET", /\/accounts\/account-0001\/vehicles$/, "vehicles");
    this.ok("GET", /battery-status$/, "battery-status");
    this.ok("GET", /cockpit$/, "cockpit");
    this.on("GET", /location$/, () => {
      const body = fixture("location") as { data: { attributes: Record<string, unknown> } };
      body.data.attributes.gpsLatitude = SENTINEL.lat;
      body.data.attributes.gpsLongitude = SENTINEL.lon;
      return { status: 200, body };
    });
    this.ok("GET", /ev\/soc-levels$/, "soc-levels");
    this.on("POST", /ev\/soc-levels$/, () => ({ status: 200, body: null }));
    this.on("POST", /actions\/horn-lights$/, () => ({ status: 200, body: { data: {} } }));
    this.on("POST", /actions\/charging-start$/, () => ({
      status: 403,
      body: fixture("charge-mode-403"),
    }));
  }

  /** Later routes win over earlier ones. */
  on(method: string, match: RegExp, reply: (c: Call) => Reply | Promise<Reply>): this {
    this.routes.unshift({ method, match, reply });
    return this;
  }

  ok(method: string, match: RegExp, name: string): this {
    return this.on(method, match, () => ({ status: 200, body: fixture(name) }));
  }

  /** Kamereon error body with this code. */
  error(method: string, match: RegExp, status: number, code: string): this {
    return this.on(method, match, () => ({
      status,
      body: { errors: [{ errorCode: code, errorMessage: "x" }] },
    }));
  }

  count(match: RegExp, method?: string): number {
    return this.calls.filter((c) => match.test(c.path) && (!method || c.method === method)).length;
  }

  readonly http: Http = async (url: string, req: HttpRequest) => {
    const path = new URL(url).pathname;
    const call: Call = {
      url,
      path,
      method: req.method,
      headers: req.headers ?? {},
      body: req.body,
    };
    this.calls.push(call);
    const route = this.routes.find((r) => r.method === req.method && r.match.test(path));
    const reply: Reply = route ? await route.reply(call) : { status: 404, body: null };
    if (reply === "network") throw new TypeError("fetch failed");
    return { status: reply.status, text: async () => JSON.stringify(reply.body) };
  };
}

export interface LoggedLine {
  level: string;
  args: unknown[];
}

export function recordingLogger(lines: LoggedLine[]): Logger {
  const make = (bindings: Record<string, unknown>): Logger => {
    const rec =
      (level: string) =>
      (...args: unknown[]) => {
        lines.push({ level, args: [bindings, ...args] });
      };
    return {
      child: (b) => make({ ...bindings, ...b }),
      info: rec("info"),
      warn: rec("warn"),
      error: rec("error"),
      debug: rec("debug"),
    } as Logger;
  };
  return make({});
}

export function fakeDeviceManager() {
  return {
    upsertFromDiscovery: vi.fn<DeviceManager["upsertFromDiscovery"]>(),
    updateDeviceData: vi.fn<DeviceManager["updateDeviceData"]>(),
    updateDeviceStatus: vi.fn<DeviceManager["updateDeviceStatus"]>(),
    removeStaleDevices: vi.fn<DeviceManager["removeStaleDevices"]>(),
    logSummary: vi.fn<DeviceManager["logSummary"]>(),
  };
}

export function fakeDeps(settings: Record<string, string> = {}) {
  const lines: LoggedLine[] = [];
  const store: Record<string, string> = { ...settings };
  const events: unknown[] = [];
  const deviceManager = fakeDeviceManager();
  const deps: PluginDeps = {
    logger: recordingLogger(lines),
    eventBus: { emit: (e) => events.push(e) },
    settingsManager: {
      get: (k) => store[k],
      set: (k, v) => {
        store[k] = v;
      },
    },
    deviceManager,
    pluginDir: "/tmp/plugin",
  };
  return { deps, lines, store, events, deviceManager };
}

/** Everything a test can observe, as one string, for leak checks. */
export function observable(...parts: unknown[]): string {
  // Errors with everything pino would print: message, stack, cause, own fields.
  return JSON.stringify(parts, (_k, v: unknown) =>
    v instanceof Error
      ? { ...v, name: v.name, message: v.message, stack: v.stack, cause: v.cause }
      : v,
  );
}
