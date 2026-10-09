/**
 * Resend, written against Resend's published REST API (https://resend.com/docs/api-reference). Off until the owner has
 * saved an API key secret and switched the provider on in the Mailbox settings: nothing builds this class otherwise.
 *
 * What it uses:
 * - `POST /emails` (from, to, cc, bcc, subject, html, text, reply_to, headers, attachments, tags) with an `Idempotency-Key`
 *   header: a repeat with the same key returns the first answer for 24 hours, which is what makes a retry after a timeout safe.
 * - `POST /emails/batch`: up to 100 messages, no attachments, one idempotency key for the request, one `{ id }` per message in order.
 * - `POST /domains` (name, region, open_tracking false, click_tracking false), `GET /domains/{id}`, `GET /domains`, `POST /domains/{id}/verify`: the records Resend asks for
 *   come back on the domain (SPF as an MX and a TXT on the `send` return-path host, DKIM at `resend._domainkey`). They are handed
 *   to whoever controls the DNS; this adapter never edits DNS. Domain calls need a full-access key, a sending-only key is refused
 *   with 401 `restricted_api_key`.
 * - **Tracking is a setting of the domain, not of a message** (Create Domain and Update Domain take `open_tracking` and `click_tracking`, Get
 *   Domain returns them; the send call has no such parameter). So this adapter never adds a pixel and never rewrites a link itself
 *   (`toResendPayload` hands over the html and text exactly as given), registers every domain with both switched OFF, and reads the two
 *   flags back so the sender can refuse a message that must keep its links intact (a signing link is a bearer token in the URL
 *   fragment) through a domain somebody switched tracking on for.
 * - Errors are `{ statusCode, name, message }`. 429 `rate_limit_exceeded` carries `retry-after`; `daily_quota_exceeded` and
 *   `monthly_quota_exceeded` are quota; 403 `validation_error` "domain is not verified" is an unverified domain.
 *
 * Webhook events (`email.delivered`, `email.bounced` with `bounce.type` Permanent, Transient or Undetermined, `email.complained`,
 * `email.delivery_delayed`, `email.failed`, `email.opened`, `email.clicked`, `email.suppressed`, `domain.*`) are signed with Svix
 * (`svix.ts`); `parseResendEvent` reads the body once it has verified.
 */
import { organizationalDomain } from "../dns.js";
import { EspApiError, type BatchOutcome, type DnsRecord, type EmailProvider, type EspEmail, type ProviderDomain, type ProviderDomainStatus, type SendOutcome } from "./types.js";
import type { RateLimiter } from "./limiter.js";

export const RESEND_API = "https://api.resend.com";
export const RESEND_TIMEOUT_MS = 25_000;
/** Resend's regions: a client in South Africa is usually served from eu-west-1, the owner may pick another. */
export const RESEND_REGIONS = ["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"] as const;
export const DEFAULT_REGION = "us-east-1";

/** The part of fetch the adapter needs: the host's guarded `ctx.http.fetch` or a test double. */
export type HttpFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface ResendOptions {
  apiKey: string;
  fetch: HttpFetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** Keeps to Resend's requests-per-second limit. */
  limiter?: RateLimiter | null;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function short(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 300);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ResendFailure {
  kind: "rejected" | "unverified" | "config" | "quota" | "retry" | "unknown" | "conflict";
  status: number | null;
  code: string | null;
  error: string;
  retryAfterSeconds: number | null;
}

/** Turns an error answer into what the sender does about it. Exported so the mapping is tested on its own. */
export function classifyResendFailure(status: number | null, body: unknown, retryAfter: string | null = null): ResendFailure {
  const b = obj(body);
  const code = text(b.name);
  const message = short(text(b.message) ?? (status ? `Resend answered HTTP ${status}` : "Resend did not answer"));
  const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Math.ceil(Number(retryAfter)) : null;
  const base = { status, code, error: message, retryAfterSeconds: seconds };
  if (status === 429) {
    if (code === "daily_quota_exceeded" || code === "monthly_quota_exceeded") return { kind: "quota", ...base };
    return { kind: "retry", ...base };
  }
  if (status === 409) {
    if (code === "invalid_idempotent_request") return { kind: "conflict", ...base };
    return { kind: "retry", ...base };
  }
  if (status === 403 && code === "validation_error") {
    // "The example.com domain is not verified" and "You can only send testing emails to your own address": the domain is not usable yet.
    if (/not verified|only send testing emails/i.test(message)) return { kind: "unverified", ...base };
    return { kind: "rejected", ...base };
  }
  if (status === 401 || status === 403) return { kind: "config", ...base };
  if (status === 503) return { kind: "retry", ...base };
  if (status != null && status >= 500) return { kind: "unknown", ...base };
  return { kind: "rejected", ...base };
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/**
 * The `POST /emails` body for a message. It carries only what the message says: no tracking switch (the send call has none), no pixel,
 * and the html and text byte for byte as given, so a link in them reaches the provider unchanged.
 */
export function toResendPayload(email: EspEmail): Record<string, unknown> {
  const body: Record<string, unknown> = { from: email.from, to: email.to, subject: email.subject };
  if (email.cc?.length) body.cc = email.cc;
  if (email.bcc?.length) body.bcc = email.bcc;
  if (email.html) body.html = email.html;
  if (email.text) body.text = email.text;
  if (email.replyTo) body.reply_to = email.replyTo;
  if (email.headers && Object.keys(email.headers).length > 0) body.headers = email.headers;
  if (email.tags?.length) body.tags = email.tags;
  if (email.attachments?.length) body.attachments = email.attachments.map((file) => ({ filename: file.filename, content: file.contentBase64, content_type: file.contentType }));
  return body;
}

/** Tag names and values may hold only ASCII letters, digits, underscores and dashes (256 characters at most). */
export function tagValue(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "_";
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

const STATUSES = new Set<ProviderDomainStatus>(["not_started", "pending", "verified", "failed", "temporary_failure"]);

export function domainStatus(value: unknown): ProviderDomainStatus {
  const status = text(value)?.toLowerCase();
  return status && STATUSES.has(status as ProviderDomainStatus) ? (status as ProviderDomainStatus) : "unknown";
}

/** The host of a record: the provider gives it relative to the domain (`send`), sometimes already complete (`links.example.com`). */
export function recordHost(name: string, domain: string): string {
  const clean = name.trim().replace(/\.$/, "").toLowerCase();
  if (!clean || clean === "@") return domain;
  if (clean === domain || clean.endsWith(`.${domain}`)) return clean;
  return `${clean}.${domain}`;
}

/** The host to type at the DNS provider when the zone is the registered domain: `send.updates.client.co.za` in zone `client.co.za` is `send.updates`. */
export function hostInZone(fqdn: string, domain: string): string {
  const zone = organizationalDomain(domain);
  if (fqdn === zone) return "@";
  return fqdn.endsWith(`.${zone}`) ? fqdn.slice(0, -zone.length - 1) : fqdn;
}

function purposeOf(record: string, type: string, name: string): string {
  const kind = record.toUpperCase();
  if (kind === "SPF" && type === "MX") return "Where bounces and feedback go (the provider's return path). Without it SPF cannot pass for this domain.";
  if (kind === "SPF") return "SPF for the return path: says the provider may send for this domain.";
  if (kind === "DKIM") return `DKIM key (selector ${name.split(".")[0]}): the provider signs every message with it.`;
  if (kind === "TRACKING") return "Open and click tracking link (only when tracking is on).";
  if (kind === "RECEIVING") return "Lets the provider receive replies (not used by the Mailbox).";
  return `${record} record.`;
}

function parseRecord(raw: unknown, domain: string): DnsRecord | null {
  const r = obj(raw);
  const record = text(r.record) ?? "";
  const type = text(r.type)?.toUpperCase();
  const name = text(r.name);
  const value = text(r.value);
  if (!name || !value || (type !== "TXT" && type !== "MX" && type !== "CNAME")) return null;
  const priority = typeof r.priority === "number" && Number.isInteger(r.priority) ? r.priority : null;
  const fqdn = recordHost(name, domain);
  return {
    record: record || type,
    type,
    name,
    fqdn,
    // Resend shows TXT values in quotes; a DNS panel wants the text itself.
    value: type === "TXT" ? value.replace(/^"(.*)"$/s, "$1") : value,
    priority,
    ttl: text(r.ttl),
    status: domainStatus(r.status),
    purpose: purposeOf(record || type, type, name),
  };
}

/** A domain object from any of the domain endpoints. */
export function parseResendDomain(raw: unknown): ProviderDomain {
  const d = obj(raw);
  const id = text(d.id);
  const name = text(d.name)?.toLowerCase();
  if (!id || !name) throw new EspApiError("Resend answered with a domain that has no id or name", "rejected", null);
  const records = (Array.isArray(d.records) ? d.records : []).map((entry) => parseRecord(entry, name)).filter((entry): entry is DnsRecord => Boolean(entry));
  const spfTxt = records.find((entry) => entry.record.toUpperCase() === "SPF" && entry.type === "TXT");
  const spfMx = records.find((entry) => entry.record.toUpperCase() === "SPF" && entry.type === "MX");
  const dkim = records.find((entry) => entry.record.toUpperCase() === "DKIM");
  const include = spfTxt ? /(?:^|\s)include:(\S+)/i.exec(spfTxt.value)?.[1]?.toLowerCase() ?? null : null;
  // Only a real boolean counts: a field that is missing or of another type says nothing, and nothing is not "off".
  const flag = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
  return {
    id,
    name,
    status: domainStatus(d.status),
    region: text(d.region),
    records,
    returnPathHost: (spfTxt ?? spfMx)?.fqdn ?? null,
    dkimSelector: dkim ? dkim.name.split(".")[0]!.toLowerCase() : null,
    spfInclude: include,
    openTracking: flag(d.open_tracking),
    clickTracking: flag(d.click_tracking),
  };
}

// ---------------------------------------------------------------------------
// Events (what the webhook carries)
// ---------------------------------------------------------------------------

export type ResendEventKind =
  | "sent"
  | "delivered"
  | "delayed"
  | "bounced_hard"
  | "bounced_soft"
  | "complained"
  | "failed"
  | "opened"
  | "clicked"
  | "suppressed"
  | "domain"
  | "other";

export interface ResendEvent {
  /** The raw `type`, for the log. */
  type: string;
  kind: ResendEventKind;
  emailId: string | null;
  from: string | null;
  /** Every recipient the message had. */
  to: string[];
  createdAt: string | null;
  /** Our tags (`pib_company`). */
  tags: Record<string, string>;
  bounce: { type: string | null; subType: string | null; message: string | null } | null;
  failedReason: string | null;
  /** `domain.*` events: the provider's domain id. */
  domainId: string | null;
}

function parseTags(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  // The webhook shows tags as an object; the send API takes a list of name and value. Both are read.
  if (Array.isArray(value)) {
    for (const entry of value) {
      const t = obj(entry);
      if (typeof t.name === "string" && typeof t.value === "string") out[t.name] = t.value;
    }
  } else {
    for (const [name, v] of Object.entries(obj(value))) if (typeof v === "string") out[name] = v;
  }
  return out;
}

/** The first address of a `Name <a@b.co>` or `a@b.co` value, lower case. */
export function addressOf(value: string | null | undefined): string | null {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(value ?? "") ?? /^\s*([^\s<>]+@[^\s<>]+)\s*$/.exec(value ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

/** Reads a verified webhook body. Returns null for anything that is not an object with a `type`. */
export function parseResendEvent(rawBody: string): ResendEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const body = obj(parsed);
  const type = text(body.type);
  if (!type) return null;
  const data = obj(body.data);
  const bounce = data.bounce && typeof data.bounce === "object" ? obj(data.bounce) : null;
  let kind: ResendEventKind = "other";
  switch (type) {
    case "email.sent":
      kind = "sent";
      break;
    case "email.delivered":
      kind = "delivered";
      break;
    case "email.delivery_delayed":
      kind = "delayed";
      break;
    case "email.bounced":
      // Permanent is a hard bounce. Transient (full mailbox, message too large, content rejected) and Undetermined are not proof that the address is dead.
      kind = (text(bounce?.type) ?? "").toLowerCase() === "permanent" ? "bounced_hard" : "bounced_soft";
      break;
    case "email.complained":
      kind = "complained";
      break;
    case "email.failed":
      kind = "failed";
      break;
    case "email.opened":
      kind = "opened";
      break;
    case "email.clicked":
      kind = "clicked";
      break;
    case "email.suppressed":
      kind = "suppressed";
      break;
    default:
      if (type.startsWith("domain.")) kind = "domain";
  }
  const to = (Array.isArray(data.to) ? data.to : typeof data.to === "string" ? [data.to] : []).map((entry) => addressOf(String(entry))).filter((entry): entry is string => Boolean(entry));
  return {
    type,
    kind,
    emailId: kind === "domain" ? null : text(data.email_id),
    from: text(data.from),
    to: [...new Set(to)],
    createdAt: text(body.created_at) ?? text(data.created_at),
    tags: parseTags(data.tags),
    bounce: bounce ? { type: text(bounce.type), subType: text(bounce.subType), message: text(bounce.message) } : null,
    failedReason: text(obj(data.failed).reason),
    domainId: kind === "domain" ? text(data.id) ?? text(data.domain_id) : null,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class ResendProvider implements EmailProvider {
  readonly key = "resend" as const;
  readonly idempotentSends = true;
  readonly batching = true;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: ResendOptions) {
    if (!options.apiKey || !/^re_[A-Za-z0-9_]{8,}$/.test(options.apiKey.trim())) throw new Error("The Resend API key should start with re_.");
    this.base = (options.baseUrl ?? RESEND_API).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? RESEND_TIMEOUT_MS;
  }

  /** One request. The caller decides what a thrown error means; a rate-limited wait that is too long comes back as `limited`. */
  private async call(method: "GET" | "POST", path: string, init: { body?: unknown; idempotencyKey?: string } = {}): Promise<{ status: number; json: unknown; retryAfter: string | null } | { limited: true }> {
    if (this.options.limiter && !(await this.options.limiter.acquire())) return { limited: true };
    const headers: Record<string, string> = { Authorization: `Bearer ${this.options.apiKey.trim()}`, Accept: "application/json" };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Resend did not answer within ${Math.round(this.timeoutMs / 1000)} seconds`)), this.timeoutMs);
    });
    try {
      const res = await Promise.race([this.options.fetch(`${this.base}${path}`, { method, headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }), deadline]);
      const raw = await res.text().catch(() => "");
      let json: unknown = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }
      const retryAfter = res.headers.get("retry-after");
      if (res.status === 429 && this.options.limiter) {
        const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : 1;
        this.options.limiter.pause(seconds);
      }
      return { status: res.status, json, retryAfter };
    } finally {
      clearTimeout(timer);
    }
  }

  private static tooBusy(): ResendFailure {
    return { kind: "retry", status: null, code: "local_rate_limit", error: "Waiting for Resend's request rate limit; it is tried again shortly", retryAfterSeconds: 2 };
  }

  async send(email: EspEmail): Promise<SendOutcome> {
    let answer;
    try {
      answer = await this.call("POST", "/emails", { body: toResendPayload(email), idempotencyKey: email.idempotencyKey });
    } catch (error) {
      // No answer at all: the message may or may not have been accepted. Only a retry with the same key is safe.
      return { ok: false, kind: "unknown", status: null, code: null, error: short(error instanceof Error ? error.message : String(error)) };
    }
    if ("limited" in answer) return { ok: false, ...ResendProvider.tooBusy() };
    if (answer.status >= 200 && answer.status < 300) {
      const id = text(obj(answer.json).id);
      // A success with no id cannot be traced by its webhooks: treat it as unknown rather than as sent.
      return id ? { ok: true, id } : { ok: false, kind: "unknown", status: answer.status, code: null, error: "Resend accepted the request but returned no message id" };
    }
    return { ok: false, ...classifyResendFailure(answer.status, answer.json, answer.retryAfter) };
  }

  async sendBatch(emails: EspEmail[], batchKey: string): Promise<BatchOutcome> {
    if (emails.length === 0) return { ok: true, ids: [] };
    if (emails.length > 100) return { ok: false, kind: "rejected", status: null, code: "batch_too_large", error: "A batch carries at most 100 messages" };
    if (emails.some((email) => (email.attachments?.length ?? 0) > 0)) return { ok: false, kind: "rejected", status: null, code: "batch_attachments", error: "A batch cannot carry attachments" };
    let answer;
    try {
      answer = await this.call("POST", "/emails/batch", { body: emails.map(toResendPayload), idempotencyKey: batchKey });
    } catch (error) {
      return { ok: false, kind: "unknown", status: null, code: null, error: short(error instanceof Error ? error.message : String(error)) };
    }
    if ("limited" in answer) return { ok: false, ...ResendProvider.tooBusy() };
    if (answer.status >= 200 && answer.status < 300) {
      const data = obj(answer.json).data;
      const ids = (Array.isArray(data) ? data : []).map((entry) => text(obj(entry).id));
      if (ids.length !== emails.length || ids.some((id) => !id)) return { ok: false, kind: "unknown", status: answer.status, code: null, error: "Resend answered the batch with a different number of ids than messages" };
      return { ok: true, ids: ids as string[] };
    }
    return { ok: false, ...classifyResendFailure(answer.status, answer.json, answer.retryAfter) };
  }

  /** A domain call: an error answer becomes an `EspApiError`. */
  private async domainCall(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let answer;
    try {
      answer = await this.call(method, path, body === undefined ? {} : { body });
    } catch (error) {
      throw new EspApiError(`Resend did not answer: ${short(error instanceof Error ? error.message : String(error))}`, "unknown", null);
    }
    if ("limited" in answer) throw new EspApiError("Waiting for Resend's request rate limit; try again in a moment", "retry", null, "local_rate_limit");
    if (answer.status >= 200 && answer.status < 300) return answer.json;
    const failure = classifyResendFailure(answer.status, answer.json, answer.retryAfter);
    if (answer.status === 404) throw new EspApiError(`Resend has no such domain (${failure.error})`, "not_found", 404, failure.code);
    if (answer.status === 403 && /registered already|already (been )?registered|already exists/i.test(failure.error)) throw new EspApiError(failure.error, "exists", 403, failure.code);
    if (answer.status === 401 && failure.code === "restricted_api_key") {
      throw new EspApiError("The Resend API key is restricted to sending. Managing domains needs a key with full access: create one at https://resend.com/api-keys and save it as the Mailbox's Resend API key secret.", "config", 401, failure.code);
    }
    throw new EspApiError(failure.error, failure.kind, answer.status, failure.code);
  }

  async addDomain(input: { name: string; region?: string | null }): Promise<ProviderDomain> {
    const region = input.region && (RESEND_REGIONS as readonly string[]).includes(input.region) ? input.region : DEFAULT_REGION;
    // Tracking off, said out loud: the provider's own default is not documented, and tracking would rewrite the links of every message from the domain.
    return parseResendDomain(await this.domainCall("POST", "/domains", { name: input.name, region, open_tracking: false, click_tracking: false }));
  }

  async getDomain(id: string): Promise<ProviderDomain> {
    return parseResendDomain(await this.domainCall("GET", `/domains/${encodeURIComponent(id)}`));
  }

  async verifyDomain(id: string): Promise<void> {
    await this.domainCall("POST", `/domains/${encodeURIComponent(id)}/verify`);
  }

  async listDomains(): Promise<ProviderDomain[]> {
    const out: ProviderDomain[] = [];
    let after: string | null = null;
    // The list shows each domain without its records; the caller reads a domain it wants records of with getDomain.
    for (let page = 0; page < 5; page += 1) {
      const body = obj(await this.domainCall("GET", `/domains?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`));
      const data = Array.isArray(body.data) ? body.data : [];
      for (const entry of data) out.push(parseResendDomain(entry));
      if (body.has_more !== true || data.length === 0) break;
      after = text(obj(data[data.length - 1]).id);
      if (!after) break;
    }
    return out;
  }
}
