/**
 * The HTTP seam: production uses Node's fetch, tests inject a fake that
 * replays recorded answers.
 */

export interface HttpRequest {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  text(): Promise<string>;
}

export type Http = (url: string, req: HttpRequest) => Promise<HttpResponse>;

const TIMEOUT_MS = 30_000;

export const fetchHttp: Http = (url, req) =>
  fetch(url, { ...req, signal: AbortSignal.timeout(TIMEOUT_MS) });

/** Parse a body as JSON; a non-JSON body becomes `null` (never echoed). */
export async function readJson(res: HttpResponse): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
