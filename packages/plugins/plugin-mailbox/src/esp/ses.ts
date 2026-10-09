/**
 * Amazon SES (the SESv2 REST API, https://docs.aws.amazon.com/ses/latest/APIReference-V2/), written against the published API over the
 * host's guarded `ctx.http.fetch` with our own SigV4 signing (`sigv4.ts`): no AWS SDK. Off until the owner has saved both access keys
 * and switched the provider on; nothing builds this class otherwise.
 *
 * What it uses:
 * - `POST /v2/email/outbound-emails` with `Content.Raw.Data` (base64 of a MIME message built by the Mailbox's own builder, so
 *   List-Unsubscribe, List-Unsubscribe-Post, Reply-To, attachments and RFC 2047 subjects travel the one way Gmail's do), the
 *   `ConfigurationSetName` (without a configuration set SES publishes no events) and `EmailTags` (`pib_company`, `pib_send`). The answer
 *   is `{ MessageId }`.
 * - `GET /v2/email/account` (`GetAccount`): `SendQuota.MaxSendRate`, `Max24HourSend`, `SentLast24Hours`, `ProductionAccessEnabled`, `SendingEnabled`.
 * - **SES has no idempotency key.** A send whose outcome is unknown (5xx, no answer, success without a `MessageId`) may have been
 *   accepted, and repeating it could deliver it twice, so `idempotentSends` is false and the sender fails such a send for good.
 * - **No batch for distinct messages** (`SendBulkEmail` is for templates): `batching` is false and `sendBatch` is refused.
 * - Errors are AWS JSON errors: the exception name is in the `x-amzn-ErrorType` header (`TooManyRequestsException:http://...`) and the
 *   text in the body's `message`. SendEmail's documented exceptions: AccountSuspendedException, BadRequestException, LimitExceededException,
 *   MailFromDomainNotVerifiedException, MessageRejected, NotFoundException, SendingPausedException (all 400 but NotFound 404) and
 *   TooManyRequestsException (429). The API reference names NO separate daily-quota exception for SendEmail; SES reports an exhausted
 *   daily quota as `LimitExceededException` (or in the text "Daily message quota exceeded"), so both are read as `quota`.
 *
 *  * Domains (PAR-1848 T1b), the SESv2 identities API: `CreateEmailIdentity` (Easy DKIM, no `DkimSigningAttributes`), `GetEmailIdentity`,
 *   `PutEmailIdentityMailFromAttributes` and `ListEmailIdentities`. The provider domain id is the domain name. An identity somebody
 *   already created in the console (`AlreadyExistsException`) is adopted and NEVER changed: MAIL FROM is set only on an identity this
 *   adapter created in the same call. A domain is `verified` only when `VerifiedForSendingStatus` is true AND `DkimAttributes.Status` is
 *   `SUCCESS`. SES verifies on its own schedule, so `verifyDomain` does nothing.
 */
import { toMailAddress } from "../gmail/headers.js";
import { buildMime, messageIdFor } from "../gmail/mime.js";
import type { HttpFetch } from "./resend.js";
import type { RateLimiter } from "./limiter.js";
import { signSesRequest, sesHost } from "./sigv4.js";
import { EspApiError, type BatchOutcome, type EmailProvider, type EspAccountQuota, type EspEmail, type DnsRecord, type ProviderDomain, type ProviderDomainStatus, type SendFailureKind, type SendOutcome } from "./types.js";

export const SES_TIMEOUT_MS = 25_000;

export interface SesOptions {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Events are published through it; every send names it. */
  configurationSet?: string | null;
  fetch: HttpFetch;
  timeoutMs?: number;
  limiter?: RateLimiter | null;
  now?: () => number;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {});
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const queryString = (query?: Record<string, string>): string => {
  const parts = Object.entries(query ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
};
const short = (message: string): string => message.replace(/\s+/g, " ").trim().slice(0, 300);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface SesFailure {
  kind: SendFailureKind;
  status: number | null;
  code: string | null;
  error: string;
  retryAfterSeconds: number | null;
}

/** The exception name of an AWS JSON error: the header first (`Name:http://...`), then the body's `__type` (`ns#Name`) or `code`. */
export function sesErrorCode(headers: { get(name: string): string | null }, body: unknown): string | null {
  const raw = headers.get("x-amzn-errortype") ?? text(obj(body).__type) ?? text(obj(body).code);
  if (!raw) return null;
  return raw.split(":")[0]!.split("#").pop()!.trim() || null;
}

/** Turns an error answer into what the sender does about it (decision 6 of PAR-1848). Exported so the mapping is tested on its own. */
export function classifySesFailure(status: number | null, code: string | null, message: string | null, retryAfter: string | null = null): SesFailure {
  const seconds = retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Math.ceil(Number(retryAfter)) : null;
  const error = short(message ?? (status ? `SES answered HTTP ${status}` : "SES did not answer"));
  const base = { status, code, error, retryAfterSeconds: seconds };
  if (code === "LimitExceededException" || /daily message quota exceeded/i.test(error)) return { kind: "quota", ...base };
  if (status === 429 || code === "TooManyRequestsException" || code === "Throttling" || code === "ThrottlingException") return { kind: "retry", ...base };
  if (code === "SendingPausedException" || code === "AccountSuspendedException" || status === 403) return { kind: "config", ...base };
  if (code === "MessageRejected" || code === "MailFromDomainNotVerifiedException") {
    // "Email address is not verified. The following identities failed the check ..." and the MAIL FROM domain: an identity is not usable yet.
    if (code === "MailFromDomainNotVerifiedException" || /not verified|not authorized to send|identit(y|ies)/i.test(error)) return { kind: "unverified", ...base };
    return { kind: "rejected", ...base };
  }
  if (code === "BadRequestException") return { kind: "rejected", ...base };
  if (status != null && status >= 500) return { kind: "unknown", ...base };
  // An answer that says "no" and is not one of the above (NotFound, a validation error): not accepted, will not work on retry.
  return { kind: "rejected", ...base };
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

/** The `SendEmail` body for a message: Raw MIME, the configuration set and the tags. */
export function toSesPayload(email: EspEmail, options: { configurationSet?: string | null; at: Date }): Record<string, unknown> {
  const from = toMailAddress(email.from);
  if (!from) throw new Error("The From address is not valid");
  const address = (value: string) => toMailAddress(value) ?? { email: value, name: null };
  const bccOnly = email.to.length === 0 && !email.cc?.length;
  const mime = buildMime({
    from,
    to: email.to.map(address),
    ...(email.cc?.length ? { cc: email.cc.map(address) } : {}),
    // A Bcc header would show the hidden recipients to everyone if it were not stripped: they travel in `Destination` only (unless nobody else is named).
    ...(bccOnly && email.bcc?.length ? { bcc: email.bcc.map(address) } : {}),
    replyTo: email.replyTo ? address(email.replyTo) : null,
    subject: email.subject,
    text: email.text ?? null,
    html: email.html ?? null,
    messageId: messageIdFor(email.idempotencyKey, from.email),
    date: options.at,
    listUnsubscribe: email.headers?.["List-Unsubscribe"] ?? null,
    listUnsubscribePost: email.headers?.["List-Unsubscribe-Post"] ?? null,
    attachments: (email.attachments ?? []).map((file) => ({ filename: file.filename, mime: file.contentType, content: Buffer.from(file.contentBase64, "base64") })),
  });
  const body: Record<string, unknown> = {
    Content: { Raw: { Data: Buffer.from(mime, "utf8").toString("base64") } },
    Destination: { ToAddresses: email.to, ...(email.cc?.length ? { CcAddresses: email.cc } : {}), ...(email.bcc?.length ? { BccAddresses: email.bcc } : {}) },
  };
  if (options.configurationSet) body.ConfigurationSetName = options.configurationSet;
  if (email.tags?.length) body.EmailTags = email.tags.map((tag) => ({ Name: tag.name, Value: tag.value }));
  return body;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class SesProvider implements EmailProvider {
  readonly key = "ses" as const;
  readonly idempotentSends = false;
  readonly batching = false;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly base: string;

  constructor(private readonly options: SesOptions) {
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(options.region)) throw new Error("The SES region should look like eu-north-1.");
    if (!options.accessKeyId.trim() || !options.secretAccessKey.trim()) throw new Error("The SES access key id and secret access key are both needed.");
    this.timeoutMs = options.timeoutMs ?? SES_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.base = `https://${sesHost(options.region)}`;
  }

  /** One signed request. A rate-limited wait that is too long comes back as `limited`; a thrown error is "no answer". */
  private async call(method: "GET" | "POST" | "PUT", path: string, body: string, query?: Record<string, string>): Promise<{ status: number; json: unknown; headers: { get(name: string): string | null } } | { limited: true }> {
    if (this.options.limiter && !(await this.options.limiter.acquire())) return { limited: true };
    const headers = signSesRequest({ method, path, ...(query ? { query } : {}), body, region: this.options.region, credentials: { accessKeyId: this.options.accessKeyId.trim(), secretAccessKey: this.options.secretAccessKey.trim() }, at: new Date(this.now()) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`SES did not answer within ${Math.round(this.timeoutMs / 1000)} seconds`)), this.timeoutMs);
    });
    try {
      const res = await Promise.race([this.options.fetch(`${this.base}${path}${queryString(query)}`, { method, headers, ...(method === "GET" ? {} : { body }) }), deadline]);
      const raw = await res.text().catch(() => "");
      let json: unknown = null;
      try {
        json = raw ? JSON.parse(raw) : null;
      } catch {
        json = null;
      }
      if (res.status === 429 && this.options.limiter) {
        const retryAfter = res.headers.get("retry-after");
        this.options.limiter.pause(retryAfter && /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : 1);
      }
      return { status: res.status, json, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  private failure(answer: { status: number; json: unknown; headers: { get(name: string): string | null } }): SesFailure {
    const code = sesErrorCode(answer.headers, answer.json);
    const message = text(obj(answer.json).message) ?? text(obj(answer.json).Message);
    const failure = classifySesFailure(answer.status, code, message, answer.headers.get("retry-after"));
    // A 429 pauses the limiter one second at least (or what Retry-After says), whatever the exception name.
    if (failure.kind === "retry" && failure.retryAfterSeconds == null) failure.retryAfterSeconds = 1;
    return failure;
  }

  async send(email: EspEmail): Promise<SendOutcome> {
    let payload: string;
    try {
      payload = JSON.stringify(toSesPayload(email, { configurationSet: this.options.configurationSet, at: new Date(this.now()) }));
    } catch (error) {
      return { ok: false, kind: "rejected", status: null, code: "invalid_message", error: short(error instanceof Error ? error.message : String(error)), retryAfterSeconds: null };
    }
    let answer;
    try {
      answer = await this.call("POST", "/v2/email/outbound-emails", payload);
    } catch (error) {
      // No answer at all: SES may have accepted it, and it has no idempotency key. The sender fails this for good.
      return { ok: false, kind: "unknown", status: null, code: null, error: short(error instanceof Error ? error.message : String(error)) };
    }
    if ("limited" in answer) return { ok: false, kind: "retry", status: null, code: "local_rate_limit", error: "Waiting for the SES request rate; it is tried again shortly", retryAfterSeconds: 2 };
    if (answer.status >= 200 && answer.status < 300) {
      const id = text(obj(answer.json).MessageId);
      // A success with no MessageId cannot be traced by its events: unknown, not sent.
      return id ? { ok: true, id } : { ok: false, kind: "unknown", status: answer.status, code: null, error: "SES accepted the request but returned no MessageId" };
    }
    return { ok: false, ...this.failure(answer) };
  }

  async sendBatch(_emails: EspEmail[], _batchKey: string): Promise<BatchOutcome> {
    return { ok: false, kind: "rejected", status: null, code: "batch_unsupported", error: "SES has no batch send for distinct messages: each message is its own request" };
  }

  /** `GetAccount`: the limits and state of the SES account in this region. Throws `EspApiError`. */
  async getAccountQuota(): Promise<EspAccountQuota> {
    let answer;
    try {
      answer = await this.call("GET", "/v2/email/account", "");
    } catch (error) {
      throw new EspApiError(`SES did not answer: ${short(error instanceof Error ? error.message : String(error))}`, "unknown", null);
    }
    if ("limited" in answer) throw new EspApiError("Waiting for the SES request rate; try again in a moment", "retry", null, "local_rate_limit");
    if (answer.status < 200 || answer.status >= 300) {
      const failure = this.failure(answer);
      throw new EspApiError(failure.error, failure.kind, answer.status, failure.code);
    }
    const body = obj(answer.json);
    const quota = obj(body.SendQuota);
    const number = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
    return {
      maxSendRate: number(quota.MaxSendRate, 1),
      max24HourSend: number(quota.Max24HourSend, 200),
      sentLast24Hours: number(quota.SentLast24Hours, 0),
      // A missing flag is read in the safe direction for production access (sandbox) and the open one for sending (enabled): SES refuses a paused account itself.
      productionAccessEnabled: body.ProductionAccessEnabled === true,
      sendingEnabled: body.SendingEnabled !== false,
    };
  }

  // -------------------------------------------------------------------------
  // Domains
  // -------------------------------------------------------------------------

  /** One identities call; throws `EspApiError` for anything but a 2xx (`exists` for AlreadyExistsException, `not_found` for a 404). */
  private async identityCall(method: "GET" | "POST" | "PUT", path: string, body: unknown, query?: Record<string, string>): Promise<Obj> {
    let answer;
    try {
      answer = await this.call(method, path, method === "GET" ? "" : JSON.stringify(body ?? {}), query);
    } catch (error) {
      throw new EspApiError(`SES did not answer: ${short(error instanceof Error ? error.message : String(error))}`, "unknown", null);
    }
    if ("limited" in answer) throw new EspApiError("Waiting for the SES request rate; try again in a moment", "retry", null, "local_rate_limit");
    if (answer.status >= 200 && answer.status < 300) return obj(answer.json);
    const failure = this.failure(answer);
    if (failure.code === "AlreadyExistsException") throw new EspApiError(failure.error, "exists", answer.status, failure.code);
    if (answer.status === 404 || failure.code === "NotFoundException") throw new EspApiError(failure.error, "not_found", answer.status, failure.code);
    throw new EspApiError(failure.error, failure.kind, answer.status, failure.code);
  }

  /** `GetEmailIdentity`: the identity as the seam's domain. */
  private async readDomain(name: string): Promise<ProviderDomain> {
    return toProviderDomain(name, this.options.region, await this.identityCall("GET", `/v2/email/identities/${encodeURIComponent(name)}`, null));
  }

  async addDomain(input: { name: string; region?: string | null }): Promise<ProviderDomain> {
    const name = input.name.trim().toLowerCase();
    let created = true;
    try {
      await this.identityCall("POST", "/v2/email/identities", { EmailIdentity: name });
    } catch (error) {
      // An identity somebody verified in the console is adopted as it is.
      if (error instanceof EspApiError && error.kind === "exists") created = false;
      else throw error;
    }
    if (created) {
      // Only an identity this call created gets a custom MAIL FROM; the Mailbox never changes one it did not create.
      // A refusal here (an IAM key without the permission) leaves a working identity on SES's default MAIL FROM, so the domain is still returned.
      await this.identityCall("PUT", `/v2/email/identities/${encodeURIComponent(name)}/mail-from`, { MailFromDomain: `mail.${name}`, BehaviorOnMxFailure: "USE_DEFAULT_VALUE" }).catch(() => undefined);
    }
    return this.readDomain(name);
  }

  async getDomain(id: string): Promise<ProviderDomain> {
    return this.readDomain(id);
  }

  /** SES looks at the DNS on its own schedule; there is nothing to ask. */
  async verifyDomain(_id: string): Promise<void> {}

  async listDomains(): Promise<ProviderDomain[]> {
    const names: string[] = [];
    let token: string | null = null;
    // Bounded: a page is up to 1000 identities.
    for (let page = 0; page < 20; page += 1) {
      const body = await this.identityCall("GET", "/v2/email/identities", null, { PageSize: "1000", ...(token ? { NextToken: token } : {}) });
      for (const entry of Array.isArray(body.EmailIdentities) ? body.EmailIdentities : []) {
        const item = obj(entry);
        const name = text(item.IdentityName);
        if (name && item.IdentityType === "DOMAIN") names.push(name);
      }
      token = text(body.NextToken);
      if (!token) break;
    }
    const domains: ProviderDomain[] = [];
    for (const name of names) domains.push(await this.readDomain(name));
    return domains;
  }
}

// ---------------------------------------------------------------------------
// Identities as domains
// ---------------------------------------------------------------------------

const STATUS_BY_SES: Record<string, ProviderDomainStatus> = { SUCCESS: "verified", PENDING: "pending", FAILED: "failed", TEMPORARY_FAILURE: "temporary_failure", NOT_STARTED: "not_started" };

/** SES's word for a DKIM or MAIL FROM status, as the seam names it. */
export function sesStatus(value: unknown): ProviderDomainStatus {
  return typeof value === "string" ? STATUS_BY_SES[value] ?? "unknown" : "unknown";
}

/** Verified needs `VerifiedForSendingStatus` and DKIM `SUCCESS`; anything else is the DKIM status (a verified-for-sending identity whose DKIM is not done yet is pending). */
export function sesDomainStatus(identity: Obj): ProviderDomainStatus {
  const dkim = sesStatus(obj(identity.DkimAttributes).Status);
  if (identity.VerifiedForSendingStatus === true && dkim === "verified") return "verified";
  if (dkim === "verified") return "pending";
  if (dkim !== "unknown") return dkim;
  return sesStatus(identity.VerificationStatus) === "verified" ? "pending" : sesStatus(identity.VerificationStatus);
}

/** The records for an identity: the three DKIM CNAMEs, and the MAIL FROM MX and TXT only when a custom MAIL FROM is set. */
export function sesRecords(name: string, region: string, identity: Obj): DnsRecord[] {
  const dkim = obj(identity.DkimAttributes);
  const dkimStatus = sesStatus(dkim.Status);
  const records: DnsRecord[] = [];
  for (const token of Array.isArray(dkim.Tokens) ? dkim.Tokens : []) {
    const t = text(token);
    if (!t) continue;
    records.push({ record: "DKIM", type: "CNAME", name: `${t}._domainkey`, fqdn: `${t}._domainkey.${name}`, value: `${t}.dkim.amazonses.com`, priority: null, ttl: null, status: dkimStatus, purpose: "DKIM: lets receivers check that SES signed the mail as this domain." });
  }
  const mailFrom = obj(identity.MailFromAttributes);
  const mailFromDomain = text(mailFrom.MailFromDomain);
  if (mailFromDomain) {
    const status = sesStatus(mailFrom.MailFromDomainStatus);
    records.push(
      { record: "SPF", type: "MX", name: mailFromDomain.endsWith(`.${name}`) ? mailFromDomain.slice(0, -name.length - 1) : mailFromDomain, fqdn: mailFromDomain, value: `feedback-smtp.${region}.amazonses.com`, priority: 10, ttl: null, status, purpose: "Custom MAIL FROM: bounces come back to SES at this host." },
      { record: "SPF", type: "TXT", name: mailFromDomain.endsWith(`.${name}`) ? mailFromDomain.slice(0, -name.length - 1) : mailFromDomain, fqdn: mailFromDomain, value: "v=spf1 include:amazonses.com ~all", priority: null, ttl: null, status, purpose: "SPF for the custom MAIL FROM host, so SPF aligns with the domain." },
    );
  }
  return records;
}

export function toProviderDomain(name: string, region: string, identity: Obj): ProviderDomain {
  const dkim = obj(identity.DkimAttributes);
  const firstToken = (Array.isArray(dkim.Tokens) ? dkim.Tokens : []).map(text).find((t): t is string => Boolean(t)) ?? null;
  const mailFromDomain = text(obj(identity.MailFromAttributes).MailFromDomain);
  return {
    id: name,
    name,
    status: sesDomainStatus(identity),
    region,
    records: sesRecords(name, region, identity),
    returnPathHost: mailFromDomain,
    dkimSelector: firstToken,
    spfInclude: "amazonses.com",
    // Tracking belongs to the configuration set (the Mailbox's has none), never to the identity.
    openTracking: false,
    clickTracking: false,
  };
}
