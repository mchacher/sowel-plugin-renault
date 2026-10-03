import { gigyaError, RenaultError } from "./errors.js";
import { readJson, type Http } from "./http.js";

export interface SessionConfig {
  gigyaUrl: string;
  gigyaApiKey: string;
  email: string;
  password: string;
}

/** Where the long-lived login token is kept between restarts. */
export interface LoginTokenStore {
  get(): string | undefined;
  set(token: string | undefined): void;
}

/** Refresh this long before the JWT's own expiry. */
const JWT_MARGIN_MS = 60_000;

/** Decode a JWT's `exp` (seconds) without checking it: Renault checks it. */
export function jwtExpiryMs(jwt: string): number | null {
  const payload = jwt.split(".")[1];
  if (!payload) return null;
  try {
    const exp = (
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    ).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Gigya session: password → login token (persisted) → person id and a JWT
 * renewed before it expires. The only holder of secrets in the plugin.
 */
export class Session {
  private jwtValue: string | null = null;
  private jwtExpiry = 0;
  private person: string | null = null;
  private pending: Promise<string> | null = null;
  /** Set on wrong credentials or two-factor: no further login until restart. */
  private fatal: RenaultError | null = null;
  /** Told once when the session fails for good (the plugin reports `error`). */
  onFatal: (err: RenaultError) => void = () => {};

  constructor(
    private readonly http: Http,
    private readonly cfg: SessionConfig,
    private readonly store: LoginTokenStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** A valid JWT, renewed when it is within a minute of its expiry. */
  async jwt(): Promise<string> {
    if (this.fatal) throw this.fatal;
    if (this.jwtValue && this.now() < this.jwtExpiry - JWT_MARGIN_MS) return this.jwtValue;
    // Concurrent callers share one renewal.
    this.pending ??= this.renew().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** The Gigya person id, which names the Kamereon person. */
  async personId(): Promise<string> {
    if (this.person) return this.person;
    await this.jwt();
    if (!this.person) throw new RenaultError("unexpected", "Renault account has no person id");
    return this.person;
  }

  /** Forget the JWT (Kamereon refused it): the next call renews it. */
  invalidateJwt(): void {
    this.jwtValue = null;
    this.jwtExpiry = 0;
  }

  private async renew(): Promise<string> {
    let token = this.store.get();
    if (token) {
      try {
        return await this.fromLoginToken(token);
      } catch (err) {
        if (!(err instanceof RenaultError) || err.kind !== "login_expired") throw err;
        this.store.set(undefined);
      }
    }
    try {
      token = await this.login();
    } catch (err) {
      // Never retry these: each retry sends the password again.
      if (
        err instanceof RenaultError &&
        (err.kind === "invalid_credentials" || err.kind === "two_factor")
      ) {
        this.fatal = err;
        this.onFatal(err);
      }
      throw err;
    }
    this.store.set(token);
    return this.fromLoginToken(token);
  }

  private async fromLoginToken(token: string): Promise<string> {
    if (!this.person) {
      const info = await this.gigya("accounts.getAccountInfo", { login_token: token });
      const personId = (info.data as { personId?: unknown } | undefined)?.personId;
      if (typeof personId !== "string")
        throw new RenaultError("unexpected", "Renault account has no person id");
      this.person = personId;
    }
    const res = await this.gigya("accounts.getJWT", {
      login_token: token,
      fields: "data.personId,data.gigyaDataCenter",
      expiration: "900",
    });
    const jwt = res.id_token;
    if (typeof jwt !== "string")
      throw new RenaultError("unexpected", "Renault returned no session");
    this.jwtValue = jwt;
    this.jwtExpiry = jwtExpiryMs(jwt) ?? this.now() + 900_000;
    return jwt;
  }

  private async login(): Promise<string> {
    const res = await this.gigya("accounts.login", {
      loginID: this.cfg.email,
      password: this.cfg.password,
    });
    const token = (res.sessionInfo as { cookieValue?: unknown } | undefined)?.cookieValue;
    if (typeof token !== "string")
      throw new RenaultError("unexpected", "Renault returned no login token");
    return token;
  }

  private async gigya(
    path: string,
    form: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let body: unknown;
    try {
      const res = await this.http(`${this.cfg.gigyaUrl}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ApiKey: this.cfg.gigyaApiKey, ...form }).toString(),
      });
      body = await readJson(res);
      if (res.status >= 500)
        throw new RenaultError("upstream", `Renault login service error (HTTP ${res.status})`);
    } catch (err) {
      if (err instanceof RenaultError) throw err;
      throw new RenaultError("network", "the Renault login service cannot be reached");
    }
    const error = gigyaError(body);
    if (error) throw error;
    if (body === null || typeof body !== "object")
      throw new RenaultError("unexpected", "Renault login answered an unreadable body");
    return body as Record<string, unknown>;
  }
}
