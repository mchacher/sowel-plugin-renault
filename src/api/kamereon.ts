import { kamereonError, RenaultError } from "./errors.js";
import { readJson, type Http } from "./http.js";
import type { RateLimiter } from "./rate.js";
import type { Session } from "./session.js";

export interface KamereonConfig {
  url: string;
  apiKey: string;
  country: string;
}

/** `overloaded` pauses the whole account this long (Home Assistant does the same). */
export const OVERLOADED_PAUSE_MS = 15 * 60_000;
/** `unauthorized` again right after a fresh JWT means throttling: back off. */
export const THROTTLED_PAUSE_MS = 15 * 60_000;

/**
 * Kamereon requests: headers, one JWT retry on `unauthorized`, error decoding,
 * all through the account's rate limiter.
 */
export class Kamereon {
  constructor(
    private readonly http: Http,
    private readonly session: Session,
    private readonly limiter: RateLimiter,
    private readonly cfg: KamereonConfig,
  ) {}

  /** GET `/commerce/v1{path}`. */
  get(path: string): Promise<unknown> {
    return this.request("GET", path);
  }

  /** POST `/commerce/v1{path}` with a JSON body. */
  post(path: string, body: unknown): Promise<unknown> {
    return this.request("POST", path, JSON.stringify(body));
  }

  private request(method: "GET" | "POST", path: string, body?: string): Promise<unknown> {
    return this.limiter.run(async () => {
      try {
        return await this.once(method, path, body);
      } catch (err) {
        if (!(err instanceof RenaultError) || err.kind !== "unauthorized") throw err;
        // Expired or revoked JWT: renew it once. Repeated, it is throttling.
        this.session.invalidateJwt();
        this.limiter.charge();
        try {
          return await this.once(method, path, body);
        } catch (again) {
          if (again instanceof RenaultError && again.kind === "unauthorized")
            this.limiter.pause(THROTTLED_PAUSE_MS);
          throw again;
        }
      }
    });
  }

  private async once(method: "GET" | "POST", path: string, body?: string): Promise<unknown> {
    const jwt = await this.session.jwt();
    const url = `${this.cfg.url}/commerce/v1${path}?country=${encodeURIComponent(this.cfg.country)}`;
    let status: number;
    let json: unknown;
    try {
      const res = await this.http(url, {
        method,
        headers: {
          "Content-Type": "application/vnd.api+json",
          apikey: this.cfg.apiKey,
          "x-gigya-id_token": jwt,
        },
        body,
      });
      status = res.status;
      json = await readJson(res);
    } catch {
      throw new RenaultError("network", "the Renault cloud cannot be reached");
    }
    if (status >= 200 && status < 300) return json;
    const err = kamereonError(status, json);
    if (err.kind === "overloaded") this.limiter.pause(OVERLOADED_PAUSE_MS);
    throw err;
  }
}
