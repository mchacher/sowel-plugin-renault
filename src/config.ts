/**
 * Plugin settings → a validated account configuration (spec 001 FR1).
 * It never logs: the password passes through here on its way to the session.
 */

import type { IntegrationSettingDef, SettingsManager } from "./sowel-api.js";
import type { Position } from "./mapping.js";

export const SETTINGS_PREFIX = "integration.renault.";

/** Account slots of the settings form; slot 1 keeps the single-account keys (spec 002). */
export const ACCOUNT_SLOTS = [1, 2, 3] as const;
export type Slot = (typeof ACCOUNT_SLOTS)[number];

/** `email` for slot 1, `email_2` for slot 2. */
export function slotKey(base: string, slot: Slot): string {
  return slot === 1 ? base : `${base}_${slot}`;
}

/** Written by the plugin, never shown in the settings form. */
export function loginTokenKey(slot: Slot): string {
  return SETTINGS_PREFIX + slotKey("login_token", slot);
}
export const LOGIN_TOKEN_KEY = loginTokenKey(1);
export const CAPABILITIES_KEY = `${SETTINGS_PREFIX}capabilities`;

export const GIGYA_URL = "https://accounts.eu1.gigya.com";
export const KAMEREON_URL = "https://api-wired-prod-1-euw1.wrd-aws.com";
/**
 * Public application keys: they identify the MyRenault app, not a user, and
 * ship in hacf-fr/renault-api and evcc (docs/renault-api.md). Overridable in
 * settings. The `gitleaks:allow` markers exempt these two lines only.
 */
// prettier-ignore
export const DEFAULT_GIGYA_API_KEY = "3_VgdkgtIRH3AdHvJm-cjV2ug2EFE0lxt0IJzMC4MFqZjFpn_GYFXVdNZ19L7wZX0N"; // gitleaks:allow
export const DEFAULT_KAMEREON_API_KEY = "YjkKtHmGfaceeuExUDKGxrLZGGvtVS0J"; // gitleaks:allow

const DEFAULT_LOCALE = "fr_FR";
const DEFAULT_HOME_RADIUS_M = 200;

/** What the accounts share. */
export interface SharedConfig {
  locale: string;
  /** Kamereon `country`, from the locale (`fr_FR` → `FR`). */
  country: string;
  gigyaApiKey: string;
  kamereonApiKey: string;
  homeRadiusM: number;
}

/** One MyRenault login. The label (never the e-mail) names it in logs and alarms. */
export interface AccountSlot {
  slot: Slot;
  label: string;
  email: string;
  password: string;
}

export interface PluginConfig {
  shared: SharedConfig;
  /** Slots with both an e-mail and a password. */
  accounts: AccountSlot[];
  /** Slots with only one of the two: ignored, warned about. */
  incomplete: Slot[];
}

function slotSettings(slot: Slot): IntegrationSettingDef[] {
  const n = slot === 1 ? "" : ` ${slot}`;
  return [
    {
      key: slotKey("email", slot),
      label: `E-mail MyRenault${n}`,
      type: "text",
      required: slot === 1,
    },
    {
      key: slotKey("password", slot),
      label: `Mot de passe MyRenault${n}`,
      type: "password",
      required: slot === 1,
    },
    {
      key: slotKey("account_label", slot),
      label: `Nom du compte${n}`,
      type: "text",
      required: false,
      placeholder: defaultLabel(slot),
    },
  ];
}

function defaultLabel(slot: Slot): string {
  return `Compte ${slot}`;
}

export const SETTINGS_SCHEMA: IntegrationSettingDef[] = [
  ...ACCOUNT_SLOTS.flatMap(slotSettings),
  {
    key: "locale",
    label: "Langue du compte",
    type: "text",
    required: false,
    defaultValue: DEFAULT_LOCALE,
    placeholder: DEFAULT_LOCALE,
  },
  {
    key: "home_radius_m",
    label: "Rayon « à la maison » (mètres)",
    type: "number",
    required: false,
    defaultValue: String(DEFAULT_HOME_RADIUS_M),
    placeholder: String(DEFAULT_HOME_RADIUS_M),
  },
  {
    key: "gigya_api_key",
    label: "Clé Gigya (si Renault la change)",
    type: "text",
    required: false,
  },
  {
    key: "kamereon_api_key",
    label: "Clé Kamereon (si Renault la change)",
    type: "text",
    required: false,
  },
];

function read(settings: SettingsManager, key: string): string {
  return (settings.get(SETTINGS_PREFIX + key) ?? "").trim();
}

function readSlot(settings: SettingsManager, slot: Slot): AccountSlot | "incomplete" | null {
  const email = read(settings, slotKey("email", slot));
  // A password may legitimately start or end with a space.
  const password = settings.get(SETTINGS_PREFIX + slotKey("password", slot)) ?? "";
  if (email === "" && password === "") return null;
  if (email === "" || password.trim() === "") return "incomplete";
  const label = read(settings, slotKey("account_label", slot)) || defaultLabel(slot);
  return { slot, label, email, password };
}

export function isConfigured(settings: SettingsManager): boolean {
  return ACCOUNT_SLOTS.some((slot) => {
    const r = readSlot(settings, slot);
    return r !== null && r !== "incomplete";
  });
}

export function readConfig(settings: SettingsManager): PluginConfig | null {
  const accounts: AccountSlot[] = [];
  const incomplete: Slot[] = [];
  for (const slot of ACCOUNT_SLOTS) {
    const r = readSlot(settings, slot);
    if (r === "incomplete") incomplete.push(slot);
    else if (r) accounts.push(r);
  }
  if (accounts.length === 0) return null;
  const locale = read(settings, "locale") || DEFAULT_LOCALE;
  const country = (locale.split(/[_-]/)[1] ?? "FR").toUpperCase();
  const radius = Number(read(settings, "home_radius_m"));
  return {
    shared: {
      locale,
      country,
      gigyaApiKey: read(settings, "gigya_api_key") || DEFAULT_GIGYA_API_KEY,
      kamereonApiKey: read(settings, "kamereon_api_key") || DEFAULT_KAMEREON_API_KEY,
      homeRadiusM: Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_HOME_RADIUS_M,
    },
    accounts,
    incomplete,
  };
}

/** Sowel's home position (global settings), or null when not set. */
export function readHome(settings: SettingsManager): Position | null {
  const lat = Number(settings.get("home.latitude"));
  const lon = Number(settings.get("home.longitude"));
  if (!settings.get("home.latitude") || !settings.get("home.longitude")) return null;
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}
