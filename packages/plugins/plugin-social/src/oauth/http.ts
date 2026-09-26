/**
 * HTTP helpers for provider APIs.
 *
 * Provider calls use native fetch: `ctx.http.fetch` stringifies binary bodies
 * and decodes every response as UTF-8, which breaks media uploads. Because
 * native fetch skips the host's SSRF guard, every URL that comes from users or
 * agents (media, Mastodon instance, Bluesky PDS) goes through
 * `assertPublicUrl` first, and redirects are followed by hand.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryable: boolean;
  readonly tokenInvalid: boolean;

  constructor(status: number, body: string, label?: string) {
    const detail = providerMessage(body) ?? (body ? body.slice(0, 300) : `HTTP ${status}`);
    super(`${label ? `${label}: ` : ""}${detail}${detail.includes(String(status)) ? "" : ` (HTTP ${status})`}`);
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body.slice(0, 4000);
    const meta = metaError(body);
    this.tokenInvalid = status === 401 || meta?.code === 190 || /invalid[_ ]token|token (has )?expired|expired[_ ]token/i.test(detail);
    this.retryable =
      !this.tokenInvalid &&
      (status === 408 || status === 425 || status === 429 || status >= 500 || meta?.is_transient === true || [1, 2, 4, 17, 32, 341].includes(meta?.code ?? -1));
  }
}

/** A validation problem a retry cannot fix (bad input, missing media...). */
export class PublishRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishRejected";
  }
}

function metaError(body: string): { code?: number; is_transient?: boolean; message?: string } | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: number; is_transient?: boolean; message?: string } };
    return parsed?.error && typeof parsed.error === "object" ? parsed.error : null;
  } catch {
    return null;
  }
}

/** Pull a readable message out of the many provider error shapes. */
export function providerMessage(body: string): string | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const err = p.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    const msg = e.error_user_msg ?? e.message ?? e.description;
    if (typeof msg === "string" && msg) return msg;
    if (typeof e.code === "string" && typeof e.message === "string") return `${e.code}: ${e.message}`;
  }
  for (const key of ["error_description", "message", "detail", "title", "error_msg"]) {
    if (typeof p[key] === "string" && p[key]) return p[key] as string;
  }
  if (typeof err === "string" && err) return err;
  if (Array.isArray(p.errors) && p.errors.length) {
    const first = p.errors[0] as Record<string, unknown> | string;
    if (typeof first === "string") return first;
    if (first && typeof first.message === "string") return first.message;
    if (first && typeof first.detail === "string") return first.detail;
  }
  return null;
}

export const timing = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  label?: string;
}

export async function request(url: string, init: RequestOptions = {}): Promise<Response> {
  const { timeoutMs = 60_000, label: _label, ...rest } = init;
  return fetch(url, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
}

export async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/** Parse a JSON response or throw ProviderHttpError with the provider's message. */
export async function readJson<T = Record<string, unknown>>(res: Response, label?: string): Promise<T> {
  const text = await readText(res);
  if (!res.ok) throw new ProviderHttpError(res.status, text, label);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderHttpError(res.status, text, label ? `${label}: invalid JSON` : "Invalid JSON");
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

export const FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };

export async function postForm<T = Record<string, unknown>>(
  url: string,
  params: Record<string, string | number | boolean | undefined | null>,
  headers: Record<string, string> = {},
  label?: string,
): Promise<T> {
  const res = await request(url, { method: "POST", headers: { ...FORM_HEADERS, Accept: "application/json", ...headers }, body: formBody(params) });
  return readJson<T>(res, label);
}

export async function getJson<T = Record<string, unknown>>(url: string, headers: Record<string, string> = {}, label?: string): Promise<T> {
  const res = await request(url, { headers: { Accept: "application/json", ...headers } });
  return readJson<T>(res, label);
}

export async function postJson<T = Record<string, unknown>>(url: string, body: unknown, headers: Record<string, string> = {}, label?: string): Promise<T> {
  const res = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return readJson<T>(res, label);
}

export function basicAuth(login: string, password: string): string {
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export function expiresAtFrom(expiresIn: unknown, now = timing.now()): string | null {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(now + seconds * 1000).toISOString();
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : typeof value === "number" ? String(value) : undefined;
}

// ── URL safety ──────────────────────────────────────────────────────────────

export type HostResolver = (hostname: string) => Promise<string[]>;

let resolver: HostResolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/** Tests replace DNS resolution. */
export function setHostResolver(next: HostResolver | null): void {
  resolver = next ?? (async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((r) => r.address));
}

function ipv4Private(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return ipv4Private(ip);
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return ipv4Private(mapped[1]!);
    return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb") || lower.startsWith("ff");
  }
  return true;
}

/** Reject non-https URLs and hosts that resolve to private or loopback addresses. */
export async function assertPublicUrl(raw: string, label = "URL"): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PublishRejected(`${label} is not a valid URL`);
  }
  if (url.protocol !== "https:") throw new PublishRejected(`${label} must use https`);
  if (url.username || url.password) throw new PublishRejected(`${label} must not contain credentials`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new PublishRejected(`${label} must point at a public host`);
  }
  const addresses = isIP(host) ? [host] : await resolver(host).catch(() => [] as string[]);
  if (addresses.length === 0) throw new PublishRejected(`${label} host ${host} could not be resolved`);
  if (addresses.some(isPrivateAddress)) throw new PublishRejected(`${label} must point at a public host`);
  return url;
}

/** Validate and normalise an instance/PDS base URL (origin only). */
export async function publicOrigin(raw: string, label: string): Promise<string> {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = await assertPublicUrl(withScheme, label);
  return url.origin;
}

/** GET a public URL, following up to `maxRedirects` redirects and re-checking each hop. */
export async function fetchPublic(raw: string, init: { maxRedirects?: number; timeoutMs?: number; label?: string } = {}): Promise<Response> {
  let current = raw;
  for (let hop = 0; hop <= (init.maxRedirects ?? 3); hop += 1) {
    await assertPublicUrl(current, init.label ?? "Media URL");
    const res = await request(current, { redirect: "manual", timeoutMs: init.timeoutMs ?? 120_000 });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new PublishRejected(`${init.label ?? "Media URL"} redirected without a location`);
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new ProviderHttpError(res.status, await readText(res), `Download ${new URL(current).host}`);
    return res;
  }
  throw new PublishRejected(`${init.label ?? "Media URL"} redirected too many times`);
}

export interface DownloadedMedia {
  bytes: Uint8Array<ArrayBuffer>;
  mime: string;
  size: number;
}

/** Download media into memory with a byte cap. */
export async function downloadMedia(url: string, options: { maxBytes: number; label?: string; fallbackMime?: string }): Promise<DownloadedMedia> {
  const res = await fetchPublic(url, { label: options.label ?? "Media URL" });
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared && declared > options.maxBytes) {
    throw new PublishRejected(`Media is ${Math.round(declared / 1_048_576)} MB; the limit here is ${Math.round(options.maxBytes / 1_048_576)} MB`);
  }
  const mime = (res.headers.get("content-type") ?? options.fallbackMime ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > options.maxBytes) throw new PublishRejected("Media is larger than allowed");
    return { bytes: buf, mime, size: buf.byteLength };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > options.maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PublishRejected(`Media is larger than ${Math.round(options.maxBytes / 1_048_576)} MB`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, mime, size };
}

export function guessMime(url: string, kind?: "image" | "video"): string {
  const path = url.toLowerCase().split("?")[0] ?? "";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "video/mp4";
  if (path.endsWith(".mov")) return "video/quicktime";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return kind === "video" ? "video/mp4" : "image/jpeg";
}

/** Poll until `check` returns a value or the deadline passes. */
export async function pollUntil<T>(
  check: () => Promise<{ done: true; value: T } | { done: false }>,
  options: { intervalMs: number; timeoutMs: number; label: string },
): Promise<T> {
  const started = timing.now();
  for (let i = 0; ; i += 1) {
    const result = await check();
    if (result.done) return result.value;
    if (timing.now() - started + options.intervalMs > options.timeoutMs) {
      throw new ProviderHttpError(504, "", `${options.label} did not finish in ${Math.round(options.timeoutMs / 1000)}s`);
    }
    await timing.sleep(options.intervalMs);
    if (i > 10_000) throw new Error("poll loop overflow");
  }
}
