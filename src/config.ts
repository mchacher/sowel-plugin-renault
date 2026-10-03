/**
 * Plugin settings → a validated account configuration (spec 001 FR1).
 * It never logs: the password passes through here on its way to the session.
 */

import type { IntegrationSettingDef, SettingsManager } from "./sowel-api.js";
import type { Position } from "./mapping.js";

export const SETTINGS_PREFIX = "integration.renault.";

/** Written by the plugin, never shown in the settings form. */
export const LOGIN_TOKEN_KEY = `${SETTINGS_PREFIX}login_token`;
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

export interface AccountConfig {
  email: string;
  password: string;
  locale: string;
  /** Kamereon `country`, from the locale (`fr_FR` → `FR`). */
  country: string;
  gigyaApiKey: string;
  kamereonApiKey: string;
  homeRadiusM: number;
}

export const SETTINGS_SCHEMA: IntegrationSettingDef[] = [
  { key: "email", label: "E-mail MyRenault", type: "text", required: true },
  { key: "password", label: "Mot de passe MyRenault", type: "password", required: true },
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

export function isConfigured(settings: SettingsManager): boolean {
  return read(settings, "email") !== "" && read(settings, "password") !== "";
}

export function readConfig(settings: SettingsManager): AccountConfig | null {
  if (!isConfigured(settings)) return null;
  const locale = read(settings, "locale") || DEFAULT_LOCALE;
  const country = (locale.split(/[_-]/)[1] ?? "FR").toUpperCase();
  const radius = Number(read(settings, "home_radius_m"));
  return {
    email: read(settings, "email"),
    // A password may legitimately start or end with a space.
    password: settings.get(SETTINGS_PREFIX + "password") ?? "",
    locale,
    country,
    gigyaApiKey: read(settings, "gigya_api_key") || DEFAULT_GIGYA_API_KEY,
    kamereonApiKey: read(settings, "kamereon_api_key") || DEFAULT_KAMEREON_API_KEY,
    homeRadiusM: Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_HOME_RADIUS_M,
  };
}

/** Sowel's home position (global settings), or null when not set. */
export function readHome(settings: SettingsManager): Position | null {
  const lat = Number(settings.get("home.latitude"));
  const lon = Number(settings.get("home.longitude"));
  if (!settings.get("home.latitude") || !settings.get("home.longitude")) return null;
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}
