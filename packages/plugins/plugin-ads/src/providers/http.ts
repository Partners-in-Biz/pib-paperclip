/**
 * HTTP for provider APIs: native fetch (injectable), a timeout, and errors that carry the platform's own message and never a token.
 */

export class ProviderError extends Error {
  readonly status: number;
  /** A retry later may work (rate limit, platform outage). */
  readonly retryable: boolean;
  /** The platform rejected the token: the connection needs signing in again. */
  readonly tokenInvalid: boolean;
  /** The platform's error code, when it gave one. */
  readonly code: string | null;

  constructor(message: string, options: { status?: number; retryable?: boolean; tokenInvalid?: boolean; code?: string | null } = {}) {
    super(redactSecrets(message));
    this.name = "ProviderError";
    this.status = options.status ?? 0;
    this.retryable = options.retryable ?? false;
    this.tokenInvalid = options.tokenInvalid ?? false;
    this.code = options.code ?? null;
  }
}

/** Removes anything token-shaped from text that may end up in a log, an issue or a comment. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(access_token|refresh_token|client_secret|fb_exchange_token|developer-token|code)=([^&\s"']+)/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer [redacted]")
    .replace(/EAA[A-Za-z0-9]{20,}/g, "[redacted]")
    .replace(/ya29\.[A-Za-z0-9._-]{20,}/g, "[redacted]");
}

export interface RequestOptions {
  fetchImpl?: typeof fetch;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  try {
    return await doFetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 45_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ProviderError(timedOut ? "The ad platform did not answer in time." : `The ad platform could not be reached (${error instanceof Error ? error.message : String(error)}).`, { retryable: true });
  }
}

export function formBody(params: Record<string, string | number | boolean | undefined | null>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    body.set(key, String(value));
  }
  return body.toString();
}

export const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
export const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json" };

/** The platform's own words out of the many error shapes (Meta, Google, OAuth). */
export function platformMessage(body: string): { message: string | null; code: string | null; transient: boolean; tokenInvalid: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { message: null, code: null, transient: false, tokenInvalid: false };
  }
  if (!parsed || typeof parsed !== "object") return { message: null, code: null, transient: false, tokenInvalid: false };
  const root = parsed as Record<string, unknown>;
  const err = (root.error ?? null) as Record<string, unknown> | string | null;
  if (typeof err === "string") return { message: typeof root.error_description === "string" ? `${err}: ${root.error_description}` : err, code: err, transient: false, tokenInvalid: err === "invalid_grant" };
  if (err && typeof err === "object") {
    // Meta: { error: { message, type, code, error_subcode, is_transient, error_user_msg } }
    const code = err.code !== undefined ? String(err.code) : null;
    const meta = typeof err.type === "string" || typeof err.fbtrace_id === "string";
    if (meta) {
      const message = typeof err.error_user_msg === "string" ? err.error_user_msg : typeof err.message === "string" ? err.message : null;
      return { message, code, transient: err.is_transient === true || ["1", "2", "4", "17", "32", "341", "613"].includes(code ?? "") || /^800\d\d$/.test(code ?? ""), tokenInvalid: code === "190" || err.type === "OAuthException" && ["102", "190"].includes(code ?? "") };
    }
    // Google Ads: { error: { code, message, status, details: [{ errors: [{ message, errorCode }] }] } }
    const details = Array.isArray(err.details) ? (err.details as Array<Record<string, unknown>>) : [];
    const first = details.flatMap((d) => (Array.isArray(d.errors) ? (d.errors as Array<Record<string, unknown>>) : []))[0];
    const detailMessage = first && typeof first.message === "string" ? first.message : null;
    const status = typeof err.status === "string" ? err.status : null;
    return {
      message: detailMessage ?? (typeof err.message === "string" ? err.message : null),
      code: status ?? code,
      transient: status === "UNAVAILABLE" || status === "RESOURCE_EXHAUSTED" || status === "DEADLINE_EXCEEDED",
      tokenInvalid: status === "UNAUTHENTICATED",
    };
  }
  return { message: null, code: null, transient: false, tokenInvalid: false };
}

export async function readJson<T = Record<string, unknown>>(res: Response, label: string): Promise<T> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }
  if (!res.ok) {
    const info = platformMessage(text);
    const retryable = res.status === 429 || res.status >= 500 || info.transient;
    const tokenInvalid = res.status === 401 || info.tokenInvalid;
    throw new ProviderError(`${label}: ${info.message ?? (text ? text.slice(0, 300) : `HTTP ${res.status}`)} (HTTP ${res.status})`, { status: res.status, retryable: retryable && !tokenInvalid, tokenInvalid, code: info.code });
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(`${label}: the ad platform sent something that is not JSON (HTTP ${res.status}).`, { status: res.status, retryable: true });
  }
}

export function expiresAtFrom(seconds: unknown, now: number = Date.now()): string | null {
  const n = typeof seconds === "number" ? seconds : typeof seconds === "string" ? Number(seconds) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? new Date(now + n * 1000).toISOString() : null;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

export function int(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function num(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}
