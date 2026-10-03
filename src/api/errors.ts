/**
 * Renault errors, decoded from Gigya and Kamereon answers.
 *
 * A message is always rebuilt from the error code, never copied from a body:
 * bodies can echo tokens or VINs, and an error travels to logs and to the UI.
 */

export type RenaultErrorKind =
  /** Gigya 403042: wrong e-mail or password, or a drifted API key. */
  | "invalid_credentials"
  /** Gigya 403101: two-factor authentication pending. */
  | "two_factor"
  /** Gigya 403005 / 403013: the login token is no longer valid. */
  | "login_expired"
  /** Kamereon: endpoint not allowed for this model. Remembered per car. */
  | "forbidden"
  /** Kamereon: no data for this car on this endpoint. Remembered per car. */
  | "not_found"
  /** Kamereon: JWT refused (expired, revoked, or throttling). Transient. */
  | "unauthorized"
  /** Kamereon: quota exceeded. Transient; pauses every request. */
  | "overloaded"
  /** Kamereon: privacy mode on in the car. */
  | "privacy"
  /** Upstream 5xx or `err.tech.*`. Transient. */
  | "upstream"
  /** No answer: DNS, TCP, TLS, timeout. Transient. */
  | "network"
  /** The plugin is stopping: queued work is dropped. */
  | "stopped"
  /** Anything else, by HTTP status only. Transient. */
  | "unexpected";

export class RenaultError extends Error {
  constructor(
    readonly kind: RenaultErrorKind,
    message: string,
    /** The vendor code (`403042`, `err.func.wired.forbidden`); never a body. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "RenaultError";
  }
}

/** Kinds that mean "this car does not offer it", worth remembering. */
export function isUnsupported(err: unknown): boolean {
  return err instanceof RenaultError && (err.kind === "forbidden" || err.kind === "not_found");
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** A Gigya answer carries `errorCode` (0 = success) in a 200 response. */
export function gigyaError(body: unknown): RenaultError | null {
  const code = asRecord(body)?.errorCode;
  if (code === 0 || code === undefined) return null;
  const c = safeCode(String(code)) ?? "unknown";
  switch (c) {
    case "403042":
      return new RenaultError("invalid_credentials", "invalid e-mail or password", c);
    case "403101":
      return new RenaultError(
        "two_factor",
        "Renault asks for two-factor authentication, which this plugin does not support yet",
        c,
      );
    case "403005":
    case "403013":
      return new RenaultError("login_expired", "Renault login expired", c);
    default:
      return new RenaultError("unexpected", `Renault login failed (code ${c})`, c);
  }
}

/** Codes look like `err.func.wired.forbidden`; anything else is not echoed. */
const CODE_SHAPE = /^[\w.-]{1,64}$/;

function safeCode(code: unknown): string | undefined {
  return typeof code === "string" && CODE_SHAPE.test(code) ? code : undefined;
}

/** The first error code of a Kamereon error body, in either of its shapes. */
function kamereonCode(body: unknown): string | undefined {
  const rec = asRecord(body);
  if (!rec) return undefined;
  for (const listKey of ["errors", "messages"]) {
    const list = rec[listKey];
    if (Array.isArray(list)) {
      const first = asRecord(list[0]);
      const code = first?.errorCode ?? first?.code;
      if (typeof code === "string") return safeCode(code);
    }
  }
  return safeCode(rec.errorCode);
}

export function kamereonError(status: number, body: unknown): RenaultError {
  const code = kamereonCode(body);
  if (code) {
    if (code.includes("forbidden"))
      return new RenaultError("forbidden", "not allowed for this vehicle", code);
    if (code.includes("notFound") || code.includes("not-found"))
      return new RenaultError("not_found", "no data for this vehicle", code);
    if (code.includes("unauthorized"))
      return new RenaultError("unauthorized", "Renault refused the session", code);
    if (code.includes("overloaded"))
      return new RenaultError("overloaded", "Renault rate limit reached", code);
    if (code.includes("privacy"))
      return new RenaultError("privacy", "privacy mode is on in the vehicle", code);
    if (code.startsWith("err.tech"))
      return new RenaultError("upstream", `Renault service error (${code})`, code);
  }
  if (status === 401) return new RenaultError("unauthorized", "Renault refused the session");
  if (status >= 500) return new RenaultError("upstream", `Renault service error (HTTP ${status})`);
  return new RenaultError(
    "unexpected",
    `Renault answered HTTP ${status}${code ? ` (${code})` : ""}`,
    code,
  );
}

/** The user-readable reason an order failed. Never a raw body. */
export function orderFailureReason(err: unknown): string {
  if (!(err instanceof RenaultError)) return "the Renault request failed";
  switch (err.kind) {
    case "network":
      return "the Renault cloud cannot be reached";
    case "overloaded":
      return "Renault's rate limit is reached, try again in a few minutes";
    case "unauthorized":
    case "login_expired":
      return "Renault refused the session, try again";
    case "invalid_credentials":
    case "two_factor":
      return `Renault login failed: ${err.message}`;
    case "privacy":
      return "privacy mode is on in the vehicle";
    case "stopped":
      return "the Renault integration is stopping";
    default:
      return err.message;
  }
}
