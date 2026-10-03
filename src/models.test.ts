import { describe, expect, it } from "vitest";
import { kamereonError, gigyaError, isUnsupported, orderFailureReason } from "./api/errors.js";
import { CapabilityMemory } from "./capabilities.js";
import { capabilitiesOf } from "./models.js";

describe("capabilitiesOf", () => {
  it("knows the Rafale refuses charge start and the Megane uses KCM", () => {
    expect(capabilitiesOf("XHN1CP").chargeStart).toBeNull();
    expect(capabilitiesOf("XCB1VE").chargeStart).toBe("kcm");
    expect(capabilitiesOf("ZZZ").chargeStart).toBe("kca");
    expect(capabilitiesOf(undefined).chargeStart).toBe("kca");
  });
});

describe("errors", () => {
  it("decodes Gigya codes", () => {
    expect(gigyaError({ errorCode: 0 })).toBeNull();
    expect(gigyaError({ errorCode: 403042 })?.kind).toBe("invalid_credentials");
    expect(gigyaError({ errorCode: 403101 })?.kind).toBe("two_factor");
    expect(gigyaError({ errorCode: 403005 })?.kind).toBe("login_expired");
    expect(gigyaError({ errorCode: 403013 })?.kind).toBe("login_expired");
    expect(gigyaError({ errorCode: 500001 })?.kind).toBe("unexpected");
  });

  it.each([
    ["err.func.wired.forbidden", "forbidden"],
    ["err.func.wired.notFound", "not_found"],
    ["err.func.wired.not-found", "not_found"],
    ["err.func.wired.unauthorized", "unauthorized"],
    ["err.func.wired.overloaded", "overloaded"],
    ["err.func.privacy.on", "privacy"],
    ["err.tech.500", "upstream"],
  ])("decodes Kamereon %s as %s", (code, kind) => {
    expect(kamereonError(400, { errors: [{ errorCode: code }] }).kind).toBe(kind);
    expect(kamereonError(400, { messages: [{ code }] }).kind).toBe(kind);
  });

  it("falls back on the HTTP status, never on the body", () => {
    expect(kamereonError(401, null).kind).toBe("unauthorized");
    expect(kamereonError(503, "secret body").kind).toBe("upstream");
    const odd = kamereonError(418, { anything: "secret body" });
    expect(odd.kind).toBe("unexpected");
    expect(odd.message).not.toContain("secret");
  });

  it("never echoes a code that does not look like one", () => {
    const err = kamereonError(418, { errors: [{ errorCode: "Bearer abc def <script>" }] });
    expect(err.message).toBe("Renault answered HTTP 418");
    expect(err.code).toBeUndefined();
  });

  it("only forbidden and notFound are unsupported", () => {
    expect(
      isUnsupported(kamereonError(403, { errors: [{ errorCode: "err.func.wired.forbidden" }] })),
    ).toBe(true);
    expect(isUnsupported(kamereonError(401, null))).toBe(false);
  });

  it("gives readable order reasons", () => {
    expect(
      orderFailureReason(
        kamereonError(429, { errors: [{ errorCode: "err.func.wired.overloaded" }] }),
      ),
    ).toMatch(/rate limit/);
    expect(orderFailureReason(new Error("raw"))).toBe("the Renault request failed");
  });
});

describe("CapabilityMemory", () => {
  it("remembers refusals and persists them", () => {
    let stored: string | undefined;
    const store = { get: () => stored, set: (v: string) => (stored = v) };
    const memory = new CapabilityMemory(store);
    expect(memory.refuse("0042", "charge_start")).toBe(true);
    expect(memory.refuse("0042", "charge_start")).toBe(false);
    expect(new CapabilityMemory(store).isRefused("0042", "charge_start")).toBe(true);
    expect(new CapabilityMemory(store).isRefused("0043", "charge_start")).toBe(false);
  });

  it("survives a corrupt value", () => {
    expect(
      new CapabilityMemory({ get: () => "{nope", set: () => {} }).isRefused("x", "cockpit"),
    ).toBe(false);
  });
});
