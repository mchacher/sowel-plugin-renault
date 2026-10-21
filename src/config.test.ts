import { describe, expect, it } from "vitest";
import {
  isConfigured,
  LOGIN_TOKEN_KEY,
  loginTokenKey,
  readConfig,
  SETTINGS_PREFIX,
  SETTINGS_SCHEMA,
} from "./config.js";
import type { SettingsManager } from "./sowel-api.js";

function settings(values: Record<string, string>): SettingsManager {
  const full = Object.fromEntries(Object.entries(values).map(([k, v]) => [SETTINGS_PREFIX + k, v]));
  return { get: (k) => full[k], set: () => {} };
}

describe("account slots", () => {
  it("reads the single-account settings of spec 001 as slot 1", () => {
    const cfg = readConfig(settings({ email: "a@b.test", password: "pw" }));
    expect(cfg?.accounts).toEqual([
      { slot: 1, label: "Compte 1", email: "a@b.test", password: "pw" },
    ]);
    expect(LOGIN_TOKEN_KEY).toBe(`${SETTINGS_PREFIX}login_token`);
  });

  it("reads slots 1 and 3, skipping the empty slot 2", () => {
    const cfg = readConfig(
      settings({ email: "a@b.test", password: "pw", email_3: "c@d.test", password_3: "pw3" }),
    );
    expect(cfg?.accounts.map((a) => [a.slot, a.label])).toEqual([
      [1, "Compte 1"],
      [3, "Compte 3"],
    ]);
    expect(loginTokenKey(3)).toBe(`${SETTINGS_PREFIX}login_token_3`);
  });

  it("ignores a slot with only an e-mail and reports it", () => {
    const cfg = readConfig(settings({ email: "a@b.test", password: "pw", email_2: "x@y.test" }));
    expect(cfg?.accounts).toHaveLength(1);
    expect(cfg?.incomplete).toEqual([2]);
  });

  it("uses the label given to a slot", () => {
    const cfg = readConfig(
      settings({ email_2: "x@y.test", password_2: "pw", account_label_2: "Megane" }),
    );
    expect(cfg?.accounts[0]).toMatchObject({ slot: 2, label: "Megane" });
  });

  it("is configured with any complete slot, not with none", () => {
    expect(isConfigured(settings({ email_2: "x@y.test", password_2: "pw" }))).toBe(true);
    expect(isConfigured(settings({ email: "a@b.test" }))).toBe(false);
    expect(readConfig(settings({}))).toBeNull();
  });

  it("declares three password fields of type password and no token", () => {
    const keys = SETTINGS_SCHEMA.map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["password", "password_2", "password_3"]));
    expect(
      SETTINGS_SCHEMA.filter((s) => s.key.startsWith("password")).every(
        (s) => s.type === "password",
      ),
    ).toBe(true);
    expect(keys.some((k) => k.startsWith("login_token"))).toBe(false);
  });
});
