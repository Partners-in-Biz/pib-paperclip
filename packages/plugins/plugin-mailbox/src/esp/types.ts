/**
 * The email provider boundary (audit Q10-7: everything sent from one Gmail account).
 *
 * Gmail stays the default and the only way to READ mail. An email provider is a
 * second, send-only kind of account: the Mailbox hands it a message and it
 * delivers from a domain the client owns, with its own signing keys, and reports
 * what happened to each message through a signed webhook. Everything specific to
 * one provider lives behind `EmailProvider`; the rules around it (who may send
 * as which domain, the do-not-email list, the daily cap while a domain warms up,
 * what a bounce or a complaint changes) are the same for every provider and are
 * tested against the `mock` one.
 *
 * Rules every adapter keeps:
 * - A provider is off until the owner switched it on in the Mailbox settings AND
 *   its secrets exist. Nothing here ever calls the network on its own.
 * - An answer that says the message was NOT accepted is never mistaken for one
 *   that did. A send whose outcome is unknown (the request timed out, a 5xx came
 *   back) is retried only with the same idempotency key, so the provider cannot
 *   send it twice.
 * - DNS is never edited by an agent: a domain call returns the records somebody
 *   with access to the DNS adds.
 */

export type EspProviderKey = "resend" | "mock";

/** Providers a real account can use. `mock` is for tests and dry runs only: no account row ever has it. */
export const REAL_ESP_PROVIDERS: ReadonlyArray<EspProviderKey> = ["resend"];

export function isEspProvider(value: unknown): value is "resend" {
  return value === "resend";
}

/** What the provider is asked to deliver. Everything is already cleaned (one line headers, plain addresses). */
export interface EspEmail {
  /** A header-ready From: `"Name" <a@b.co>`. */
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  replyTo?: string | null;
  headers?: Record<string, string>;
  attachments?: EspAttachment[];
  /** Provider tags (letters, digits, underscore and dash only): the company, so a webhook can be traced back. */
  tags?: Array<{ name: string; value: string }>;
  /** Same key on a retry: the provider returns the first answer instead of sending again. At most 256 characters. */
  idempotencyKey: string;
}

export interface EspAttachment {
  filename: string;
  contentType: string;
  /** Standard base64 of the file. */
  contentBase64: string;
}

/**
 * accepted: the provider has the message. The rest did not leave:
 * - rejected: not accepted and will not work on retry (a bad field, an invalid attachment).
 * - unverified: the sending domain is not verified at the provider.
 * - config: the API key is refused or restricted: every send fails until the owner fixes it.
 * - quota: the provider's daily or monthly sending quota is used up.
 * - retry: not accepted, try again later (rate limit, 503, another request with the same key in progress).
 * - unknown: no answer or a 5xx: it MAY have been accepted; only a retry with the same idempotency key is safe.
 * - conflict: the key was used before with a different message: the earlier attempt's outcome is unknown.
 */
export type SendFailureKind = "rejected" | "unverified" | "config" | "quota" | "retry" | "unknown" | "conflict";

export type SendOutcome =
  | { ok: true; id: string }
  | { ok: false; kind: SendFailureKind; status: number | null; code: string | null; error: string; retryAfterSeconds?: number | null };

/** One answer per message of a batch, in the order they were sent. */
export type BatchOutcome =
  | { ok: true; ids: string[] }
  | { ok: false; kind: SendFailureKind; status: number | null; code: string | null; error: string; retryAfterSeconds?: number | null };

export type ProviderDomainStatus = "not_started" | "pending" | "verified" | "failed" | "temporary_failure" | "unknown";

/** A DNS record somebody with access to the domain's DNS adds. */
export interface DnsRecord {
  /** The provider's word: SPF, DKIM, DMARC, Tracking, Receiving. */
  record: string;
  type: "TXT" | "MX" | "CNAME";
  /** The name as the provider gives it (`send`, `resend._domainkey`): relative to the domain. */
  name: string;
  /** The full host: `send.updates.client.co.za`. */
  fqdn: string;
  /** The value to put in the record, without surrounding quotes. */
  value: string;
  /** MX only. */
  priority: number | null;
  ttl: string | null;
  /** The provider's verification status of this record. */
  status: string;
  /** What the record is for, in words. */
  purpose: string;
}

export interface ProviderDomain {
  id: string;
  name: string;
  status: ProviderDomainStatus;
  region: string | null;
  records: DnsRecord[];
  /** The host mail bounces to and SPF is read at (the provider's return path), when the records name one. */
  returnPathHost: string | null;
  /** The DKIM selector the provider signs with (`resend`). */
  dkimSelector: string | null;
  /** The include the provider's SPF record asks for (`amazonses.com`). */
  spfInclude: string | null;
}

/** Thrown by the domain calls (a send returns an outcome instead). */
export class EspApiError extends Error {
  constructor(
    message: string,
    readonly kind: SendFailureKind | "not_found" | "exists",
    readonly status: number | null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "EspApiError";
  }
}

export interface EmailProvider {
  readonly key: EspProviderKey;
  send(email: EspEmail): Promise<SendOutcome>;
  /** Up to 100 messages in one request, no attachments. The key covers the whole batch. */
  sendBatch(emails: EspEmail[], batchKey: string): Promise<BatchOutcome>;
  addDomain(input: { name: string; region?: string | null }): Promise<ProviderDomain>;
  getDomain(id: string): Promise<ProviderDomain>;
  /** Asks the provider to look at the DNS again. The domain is `pending` until it has. */
  verifyDomain(id: string): Promise<void>;
  listDomains(): Promise<ProviderDomain[]>;
}

/** Most messages one batch request may carry. */
export const MAX_BATCH = 100;

// ---------------------------------------------------------------------------
// What the Mailbox stores about a provider's domains and deliveries
// ---------------------------------------------------------------------------

/** A sending domain registered at the provider. `reputation` is the last 7-day judgement (see `warmup.ts`). */
export interface EspDomainRow {
  company_id: string;
  domain: string;
  provider: string;
  provider_domain_id: string;
  region: string | null;
  status: ProviderDomainStatus;
  records: DnsRecord[];
  return_path_host: string | null;
  dkim_selector: string | null;
  spf_include: string | null;
  /** The client the domain belongs to (null: the company's own). */
  client_kind: string | null;
  client_ref: string | null;
  /** The send-only account that sends from it. */
  account_id: string | null;
  created_by: string | null;
  verified_at: string | null;
  /** When the provider's status was last read. */
  checked_at: string | null;
  /** When a verification was last asked for (it is asked at most every six hours). */
  verify_asked_at: string | null;
  /** When mail first went out from the domain: day one of the warm-up. */
  first_sent_at: string | null;
  last_sent_at: string | null;
  /** A person said this domain is already established: no warm-up cap. */
  warmup_exempt: boolean;
  /** A person's own daily cap (replaces the schedule). */
  daily_cap_override: number | null;
  reputation: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export type EspDayField = "delivered" | "hard_bounces" | "soft_bounces" | "complaints" | "opened" | "clicked" | "failed";

export const ESP_DAY_FIELDS: ReadonlyArray<EspDayField> = ["delivered", "hard_bounces", "soft_bounces", "complaints", "opened", "clicked", "failed"];

/** One UTC day of a domain's sending and what came back. `sent` counts recipients handed to the provider. */
export interface EspDayRow {
  company_id: string;
  domain: string;
  day: string;
  sent: number;
  delivered: number;
  hard_bounces: number;
  soft_bounces: number;
  complaints: number;
  opened: number;
  clicked: number;
  failed: number;
}

export interface EspEventInput {
  companyId: string;
  /** The webhook delivery id (`svix-id`): a replay of the same delivery is recorded once. */
  eventId: string;
  /** Once per message, kind and recipient for the kinds that happen once; the delivery id for opens and clicks. */
  dedupeKey: string;
  provider: string;
  type: string;
  emailId: string | null;
  /** One address, or empty when the message went to several (the provider does not say which one the event is about). */
  recipient: string;
  domain: string | null;
  sendKey: string | null;
  detail: Record<string, unknown>;
}

/** Soft bounces of one address: how many lately, and until when mail to it waits. */
export interface RecipientHealthRow {
  company_id: string;
  email: string;
  soft_bounces: number;
  first_soft_at: string;
  last_soft_at: string;
  backoff_until: string | null;
}
