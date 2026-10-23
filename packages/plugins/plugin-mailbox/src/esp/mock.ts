/**
 * A provider that records what it would have sent and touches no network and no account.
 *
 * It behaves like the real one where the Mailbox depends on it: the same idempotency key returns the first answer instead
 * of a second message, a batch carries no attachments and at most 100 messages, a domain is registered once and answers with the
 * records somebody adds to DNS, and a send from a domain that is not verified is refused. Failures are scripted per call
 * (`failNext`) so the tests can walk every branch of the sender: a 429, a timeout, a rejected message.
 */
import { EspApiError, MAX_BATCH, type BatchOutcome, type EspAccountQuota, type DnsRecord, type EmailProvider, type EspEmail, type ProviderDomain, type ProviderDomainStatus, type SendOutcome } from "./types.js";

export interface MockSend {
  email: EspEmail;
  id: string;
  /** Set when the message went in a batch. */
  batchKey: string | null;
}

export type ScriptedFailure = Extract<SendOutcome, { ok: false }>;

function recordsFor(name: string): DnsRecord[] {
  const record = (kind: string, type: DnsRecord["type"], host: string, value: string, priority: number | null = null): DnsRecord => ({
    record: kind,
    type,
    name: host,
    fqdn: `${host}.${name}`,
    value,
    priority,
    ttl: "Auto",
    status: "not_started",
    purpose: `${kind} record (mock).`,
  });
  return [
    record("SPF", "MX", "send", "feedback-smtp.us-east-1.amazonses.com", 10),
    record("SPF", "TXT", "send", "v=spf1 include:amazonses.com ~all"),
    record("DKIM", "TXT", "resend._domainkey", "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDmockmockmockmockmockmockmockmockmockmock"),
  ];
}

export class MockEmailProvider implements EmailProvider {
  readonly key = "mock" as const;
  readonly idempotentSends: boolean;
  readonly batching: boolean;
  /** What `getAccountQuota` answers (change it in a test to change the answer). Reported only when the mock was built with a quota, like SES; Resend reports none. */
  quota: EspAccountQuota | null = null;
  quotaCalls = 0;
  getAccountQuota?: () => Promise<EspAccountQuota>;

  constructor(options: { idempotentSends?: boolean; batching?: boolean; quota?: EspAccountQuota } = {}) {
    this.idempotentSends = options.idempotentSends ?? true;
    this.batching = options.batching ?? true;
    if (options.quota) {
      this.quota = options.quota;
      this.getAccountQuota = async () => {
        this.quotaCalls += 1;
        return { ...this.quota! };
      };
    }
  }
  sent: MockSend[] = [];
  /** Every message handed to send or sendBatch, accepted or not. */
  received: EspEmail[] = [];
  batches: Array<{ key: string; size: number }> = [];
  calls: string[] = [];
  /** Failures handed out, oldest first, to the next send or batch calls. `accepted` models a message the provider kept although the answer never came back. */
  private failures: Array<ScriptedFailure & { accepted?: boolean }> = [];
  private byKey = new Map<string, string>();
  private domains = new Map<string, ProviderDomain>();
  private seq = 0;
  /** Domains the mock treats as verified for sending (set by `verifyDomain` or by a test). */
  verified = new Set<string>();
  /** When true, `verifyDomain` marks the domain verified at once (DNS "was added"). */
  dnsAdded = false;

  failNext(failure: Partial<ScriptedFailure> & { kind: ScriptedFailure["kind"] }, times = 1, options: { accepted?: boolean } = {}): void {
    for (let i = 0; i < times; i += 1) this.failures.push({ ok: false, status: null, code: null, error: `scripted ${failure.kind}`, ...failure, ...(options.accepted ? { accepted: true } : {}) });
  }

  private nextId(): string {
    this.seq += 1;
    return `mock-${String(this.seq).padStart(4, "0")}`;
  }

  private domainOf(email: EspEmail): string {
    return (/<([^<>]+)>/.exec(email.from)?.[1] ?? email.from).split("@")[1]?.toLowerCase() ?? "";
  }

  private accept(email: EspEmail, batchKey: string | null): SendOutcome {
    const known = this.byKey.get(email.idempotencyKey);
    if (known) return { ok: true, id: known };
    const domain = this.domainOf(email);
    if (this.domains.size > 0 && !this.verified.has(domain)) {
      return { ok: false, kind: "unverified", status: 403, code: "validation_error", error: `The ${domain} domain is not verified. Please, add and verify your domain.` };
    }
    const id = this.nextId();
    this.byKey.set(email.idempotencyKey, id);
    this.sent.push({ email, id, batchKey });
    return { ok: true, id };
  }

  async send(email: EspEmail): Promise<SendOutcome> {
    this.calls.push("send");
    this.received.push(email);
    const failure = this.failures.shift();
    if (failure) {
      const { accepted, ...answer } = failure;
      if (accepted) this.accept(email, null);
      return answer;
    }
    return this.accept(email, null);
  }

  async sendBatch(emails: EspEmail[], batchKey: string): Promise<BatchOutcome> {
    this.calls.push("sendBatch");
    this.received.push(...emails);
    if (emails.length > MAX_BATCH) return { ok: false, kind: "rejected", status: 422, code: "validation_error", error: "A batch carries at most 100 messages" };
    if (emails.some((email) => (email.attachments?.length ?? 0) > 0)) return { ok: false, kind: "rejected", status: 422, code: "validation_error", error: "A batch cannot carry attachments" };
    const failure = this.failures.shift();
    if (failure) {
      const { accepted, ...answer } = failure;
      if (accepted) for (const email of emails) this.accept(email, batchKey);
      return answer;
    }
    this.batches.push({ key: batchKey, size: emails.length });
    const ids: string[] = [];
    for (const email of emails) {
      const outcome = this.accept(email, batchKey);
      if (!outcome.ok) return outcome;
      ids.push(outcome.id);
    }
    return { ok: true, ids };
  }

  async addDomain(input: { name: string; region?: string | null }): Promise<ProviderDomain> {
    this.calls.push("addDomain");
    const name = input.name.toLowerCase();
    if (this.domains.has(name)) throw new EspApiError(`The ${name} domain has been registered already.`, "exists", 403, "validation_error");
    this.seq += 1;
    const domain: ProviderDomain = {
      id: `dom-${this.seq}`,
      name,
      status: "not_started",
      region: input.region ?? "us-east-1",
      records: recordsFor(name),
      returnPathHost: `send.${name}`,
      dkimSelector: "resend",
      spfInclude: "amazonses.com",
      // Registered with tracking off, like the real adapter asks for.
      openTracking: false,
      clickTracking: false,
    };
    this.domains.set(name, domain);
    return structuredClone(domain);
  }

  private find(id: string): ProviderDomain {
    for (const domain of this.domains.values()) if (domain.id === id) return domain;
    throw new EspApiError("Resend has no such domain", "not_found", 404);
  }

  async getDomain(id: string): Promise<ProviderDomain> {
    this.calls.push("getDomain");
    return structuredClone(this.find(id));
  }

  async verifyDomain(id: string): Promise<void> {
    this.calls.push("verifyDomain");
    const domain = this.find(id);
    const status: ProviderDomainStatus = this.dnsAdded ? "verified" : "pending";
    domain.status = status;
    domain.records = domain.records.map((record) => ({ ...record, status }));
    if (status === "verified") this.verified.add(domain.name);
  }

  async listDomains(): Promise<ProviderDomain[]> {
    this.calls.push("listDomains");
    return [...this.domains.values()].map((domain) => structuredClone({ ...domain, records: [] }));
  }

  /** Test helper: somebody switched tracking on (or off) for the domain in the provider's dashboard; `null` is an answer that does not say. */
  setTracking(name: string, flags: { open?: boolean | null; click?: boolean | null }): void {
    const domain = this.domains.get(name.toLowerCase());
    if (!domain) return;
    if (flags.open !== undefined) domain.openTracking = flags.open;
    if (flags.click !== undefined) domain.clickTracking = flags.click;
  }

  /** Test helper: the provider has seen the DNS records. */
  markVerified(name: string): void {
    const domain = this.domains.get(name.toLowerCase());
    if (!domain) return;
    domain.status = "verified";
    domain.records = domain.records.map((record) => ({ ...record, status: "verified" }));
    this.verified.add(domain.name);
  }
}
