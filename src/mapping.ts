/**
 * Pure mapping from Renault payloads to the electric vehicle contract of core
 * spec 183. No network, no state beyond what is passed in.
 */

/** Core `EV_CHARGING_STATE_VALUES` (spec 183), in the same order. */
export const EV_CHARGING_STATES = [
  "unplugged",
  "idle",
  "scheduled",
  "waiting",
  "charging",
  "completed",
  "error",
] as const;
export type EvChargingState = (typeof EV_CHARGING_STATES)[number];

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** `chargingStatus` values that only happen with a cable in. */
const PLUGGED_STATUSES = new Set([0.1, 0.2, 0.3, 1.0, -1.3, -1.6]);

/** `plugStatus` 1/0, else inferred from `chargingStatus`; null when unknown. */
export function pluggedOf(plugStatus: unknown, chargingStatus: unknown): boolean | null {
  const plug = num(plugStatus);
  if (plug === 1) return true;
  if (plug === 0) return false;
  const cs = num(chargingStatus);
  if (cs !== undefined && PLUGGED_STATUSES.has(cs)) return true;
  return null;
}

/**
 * `charging_state` per docs/renault-api.md ("Contract mapping"). Returns
 * `previous` when Renault reports a code that says nothing (−1.1, unknown).
 */
export function chargingStateOf(
  plugStatus: unknown,
  chargingStatus: unknown,
  previous: EvChargingState | null,
): EvChargingState | null {
  if (num(plugStatus) === -1) return "error";
  const cs = num(chargingStatus);
  const plugged = pluggedOf(plugStatus, chargingStatus);
  if (plugged === false || cs === 0.4) return "unplugged";
  switch (cs) {
    case 1.0:
    case -1.6:
      return "charging";
    case 0.2:
      return "completed";
    case 0.1:
      return "scheduled";
    case 0.3:
    case -1.3:
      return "waiting";
  }
  if (plugged === true) {
    if (cs === -1.0) return "error";
    if (cs === 0.0 || cs === -1.4 || cs === -1.5) return "idle";
  }
  return previous;
}

/** A Renault timestamp as ISO 8601 UTC; null when unreadable. */
export function isoUtc(ts: unknown): string | null {
  if (typeof ts !== "string" || ts === "") return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export interface Position {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function distanceM(a: Position, b: Position): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/**
 * `at_home` from a location attributes object. The coordinates are used for
 * this comparison only: the result is a boolean, never a position.
 */
export function atHomeOf(
  location: Record<string, unknown>,
  home: Position | null,
  radiusM: number,
): boolean | null {
  if (!home) return null;
  const lat = num(location.gpsLatitude);
  const lon = num(location.gpsLongitude);
  if (lat === undefined || lon === undefined) return null;
  return distanceM({ lat, lon }, home) <= radiusM;
}

/** The `data.attributes` of a Kamereon car-adapter answer. */
export function attributesOf(body: unknown): Record<string, unknown> | null {
  const data = (body as { data?: { attributes?: unknown } } | null)?.data;
  const attrs = data?.attributes;
  return attrs !== null && typeof attrs === "object" ? (attrs as Record<string, unknown>) : null;
}

/** Contract payload of a battery-status answer. Absent fields are omitted. */
export function batteryPayload(
  attrs: Record<string, unknown>,
  previous: EvChargingState | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const level = num(attrs.batteryLevel);
  if (level !== undefined) out.battery_level = level;
  const range = num(attrs.batteryAutonomy);
  if (range !== undefined) out.range = range;
  const plugged = pluggedOf(attrs.plugStatus, attrs.chargingStatus);
  if (plugged !== null) out.plugged = plugged;
  const state = chargingStateOf(attrs.plugStatus, attrs.chargingStatus, previous);
  if (state !== null) out.charging_state = state;
  const at = isoUtc(attrs.timestamp);
  if (at !== null) out.reported_at = at;
  return out;
}

/** Contract and extra payload of a cockpit answer. */
export function cockpitPayload(attrs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const mileage = num(attrs.totalMileage);
  if (mileage !== undefined) out.mileage = mileage;
  const fuelRange = num(attrs.fuelAutonomy);
  if (fuelRange !== undefined) out.fuel_range = fuelRange;
  const fuelQuantity = num(attrs.fuelQuantity);
  if (fuelQuantity !== undefined) out.fuel_quantity = fuelQuantity;
  return out;
}

export interface SocLevels {
  socMin: number;
  socTarget: number;
}

/** soc-levels is not wrapped in `data`. */
export function socLevelsOf(body: unknown): SocLevels | null {
  const rec = body as { socMin?: unknown; socTarget?: unknown } | null;
  const socMin = num(rec?.socMin);
  const socTarget = num(rec?.socTarget);
  return socMin !== undefined && socTarget !== undefined ? { socMin, socTarget } : null;
}

export const CHARGE_LIMIT_MIN = 55;
export const CHARGE_LIMIT_MAX = 100;

/** A requested limit, rounded to Renault's step of 5 within 55–100. */
export function chargeLimitTarget(value: unknown): number | null {
  const v = typeof value === "string" ? Number(value) : value;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(CHARGE_LIMIT_MAX, Math.max(CHARGE_LIMIT_MIN, Math.round(v / 5) * 5));
}
