/**
 * The email provider under test: the Mailbox's usual fake host and Gmail, a mock provider, DNS that answers like a verified Resend
 * domain, and helpers that put a send-only account and its domain in the store the way `add-sending-domain` leaves them.
 */
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { MAIL_EVENTS, pluginEvent, PIB_PLUGINS, type MailSendRequested } from "@partnersinbiz/pib-plugin-kit";
import { forgetLimiters } from "../../src/esp/limiter.js";
import { MockEmailProvider } from "../../src/esp/mock.js";
import { forgetEspRuntime } from "../../src/esp/runtime.js";
import { signSvix } from "../../src/esp/svix.js";
import { forgetWebhookCandidates } from "../../src/esp/webhook.js";
import type { DnsRecord, EspDomainRow } from "../../src/esp/types.js";
import { rememberCompany } from "../../src/setup-status.js";
import type { EspAccountQuota } from "../../src/esp/types.js";
import { fakeDns } from "./dns.js";
import { FakeSes, hostFetch, SES_ACCESS_KEY_ID, SES_CONFIGURATION_SET, SES_REGION, SES_SECRET_ACCESS_KEY } from "./fake-ses.js";
import { CO } from "./memory.js";
import { setup } from "./setup.js";

// Built at runtime: a secret-shaped literal in a test file is refused by GitHub push protection.
export const API_KEY = ["re", "abcdefghijklmnopqrstuvwxyz012345"].join("_");
export const WEBHOOK_SECRET = ["whsec", Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")].join("_");
export const OTHER_SECRET = ["whsec", Buffer.from("fedcba9876543210fedcba9876543210").toString("base64")].join("_");

export const DOMAIN = "updates.client.co.za";
export const FROM = `hello@${DOMAIN}`;
export const CLIENT = { kind: "company" as const, ref: "crm-client-1" };

/** The records Resend returns for DOMAIN (the doc example shape), all verified once DNS is in. */
export function providerRecords(status = "verified", domain = DOMAIN): DnsRecord[] {
  const rec = (record: string, type: DnsRecord["type"], name: string, value: string, priority: number | null = null): DnsRecord => ({ record, type, name, fqdn: `${name}.${domain}`, value, priority, ttl: "Auto", status, purpose: `${record} record` });
  return [
    rec("SPF", "MX", "send", "feedback-smtp.eu-west-1.amazonses.com", 10),
    rec("SPF", "TXT", "send", "v=spf1 include:amazonses.com ~all"),
    rec("DKIM", "TXT", "resend._domainkey", "p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84+21gn+x6SEXtjWvPiAAmnmql4cTGP5v9DJUqAC1HXLqqxXVXyOZhbLzoPFOSTqiSnSmprmP0fpv2Ql5oR3BG9zMDW+pNKQKZZYZP0V7p8ATEeB3Bp3MvvQ4vzpnB+RUCTMHNHdlSLAw/b5GZrRLwwIDAQAB"),
  ];
}

/** DNS as it is once the owner (or the client) has added every record Resend asked for. */
export function dnsVerified(domain = DOMAIN, extra: Record<string, string[]> = {}): Record<string, string[]> {
  return {
    [`MX send.${domain}`]: ["10 feedback-smtp.eu-west-1.amazonses.com."],
    [`TXT send.${domain}`]: ["v=spf1 include:amazonses.com ~all"],
    [`TXT resend._domainkey.${domain}`]: ["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84+21gn+x6SEXtjWvPiAAmnmql4cTGP5v9DJUqAC1HXLqqxXVXyOZhbLzoPFOSTqiSnSmprmP0fpv2Ql5oR3BG9zMDW+pNKQKZZYZP0V7p8ATEeB3Bp3MvvQ4vzpnB+RUCTMHNHdlSLAw/b5GZrRLwwIDAQAB"],
    [`TXT _dmarc.${domain.split(".").slice(-3).join(".")}`]: ["v=DMARC1; p=none; rua=mailto:dmarc@client.co.za"],
    "TXT _amazonses.com": [],
    ...extra,
  };
}

export const ESP_ON = { esp: { enabled: true, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, ratePerSecond: 10 } };

export function espSetup(config: Record<string, unknown> = {}) {
  forgetEspRuntime();
  forgetLimiters();
  forgetWebhookCandidates();
  const base = setup({ ...ESP_ON, ...config });
  const provider = new MockEmailProvider();
  const dns = fakeDns(dnsVerified());
  base.env.esp = { provider: () => provider };
  base.env.dns = dns;
  return { ...base, provider, dns };
}

/** Amazon SES switched on: both keys and the configuration set saved (literals; the runtime reads a secret reference the same way). */
export const SES_ON = { esp: { enabled: true, provider: "ses", ratePerSecond: 10, ses: { region: SES_REGION, accessKeyId: SES_ACCESS_KEY_ID, secretAccessKey: SES_SECRET_ACCESS_KEY, configurationSet: SES_CONFIGURATION_SET } } };

/** The mock provider behind SES settings: `idempotentSends` and `batching` false like the real adapter, so the sender's SES rules run without HTTP. */
export function sesMockSetup(config: Record<string, unknown> = {}, options: { idempotentSends?: boolean; batching?: boolean; quota?: EspAccountQuota } = {}) {
  forgetEspRuntime();
  forgetLimiters();
  forgetWebhookCandidates();
  const base = setup({ ...SES_ON, ...config });
  const provider = new MockEmailProvider({ idempotentSends: false, batching: false, ...options });
  base.env.esp = { provider: () => provider };
  base.env.dns = fakeDns(dnsVerified());
  return { ...base, provider };
}

/** SES with the real adapter over the fake SESv2 endpoint, reached through a stand-in for the host's guarded fetch. */
export function sesSetup(config: Record<string, unknown> = {}) {
  forgetEspRuntime();
  forgetLimiters();
  forgetWebhookCandidates();
  const base = setup({ ...SES_ON, ...config });
  const ses = new FakeSes();
  base.env.esp = { fetch: hostFetch(ses.handle) };
  base.env.dns = fakeDns(dnsVerified());
  return { ...base, ses };
}

type EspCtx = ReturnType<typeof espSetup>;

/** A sending domain and its send-only account in the state `add-sending-domain` leaves them (verified by default). */
export async function addEspDomain(ctx: Pick<EspCtx, "store">, options: { provider?: "resend" | "ses"; domain?: string; address?: string; status?: EspDomainRow["status"]; client?: { kind: "company" | "contact"; ref: string } | null; replyTo?: string | null; firstSent?: string | null; lastSent?: string | null; id?: string; company?: string } = {}): Promise<{ domain: string; address: string; accountId: string }> {
  const domain = options.domain ?? DOMAIN;
  const address = options.address ?? `hello@${domain}`;
  const status = options.status ?? "verified";
  const accountId = options.id ?? `esp-${domain}`;
  const company = options.company ?? CO;
  const client = options.client === undefined ? CLIENT : options.client;
  await ctx.store.insertEspAccount({ id: accountId, companyId: company, provider: options.provider ?? "resend", address, status: status === "verified" ? "connected" : "pending", fromName: client ? "Client Co" : "Partners in Biz", replyTo: options.replyTo === undefined ? "team@client.co.za" : options.replyTo, clientKind: client?.kind ?? null, clientRef: client?.ref ?? null, createdBy: "user-1" });
  const now = new Date().toISOString();
  await ctx.store.upsertEspDomain({
    company_id: company,
    domain,
    provider: options.provider ?? "resend",
    provider_domain_id: `dom-${domain}`,
    region: "eu-west-1",
    status,
    records: providerRecords(status === "verified" ? "verified" : "not_started", domain),
    return_path_host: `send.${domain}`,
    dkim_selector: "resend",
    spf_include: "amazonses.com",
    client_kind: client?.kind ?? null,
    client_ref: client?.ref ?? null,
    account_id: accountId,
    created_by: "user-1",
    verified_at: status === "verified" ? now : null,
    checked_at: now,
    verify_asked_at: null,
    first_sent_at: null,
    last_sent_at: null,
    warmup_exempt: false,
    daily_cap_override: null,
    reputation: null,
    created_at: now,
    updated_at: now,
  });
  if (options.firstSent !== undefined || options.lastSent !== undefined) await ctx.store.patchEspDomain(company, domain, { ...(options.firstSent !== undefined ? { first_sent_at: options.firstSent } : {}), ...(options.lastSent !== undefined ? { last_sent_at: options.lastSent } : {}) } as never);
  return { domain, address, accountId };
}

/** Marks the domain's stored DNS check healthy (as the daily job would after the records are in). */
export async function healthyCheck(ctx: Pick<EspCtx, "store">, domain = DOMAIN, status: "healthy" | "bad" | "warn" = "healthy", problems: Array<Record<string, unknown>> = []): Promise<void> {
  const now = new Date().toISOString();
  await ctx.store.upsertDomainCheck({ company_id: CO, domain, status, result: { problems, sendReady: status === "healthy", status }, source: "account", client_kind: null, client_ref: null, checked_at: now, first_checked_at: now, status_since: now, dmarc_none_since: null });
}

export const EVENT = pluginEvent(PIB_PLUGINS.campaigns, MAIL_EVENTS.sendRequested);

export function sendEvent(payload: unknown, eventType: string = EVENT): PluginEvent {
  return { eventId: crypto.randomUUID(), eventType: eventType as PluginEvent["eventType"], occurredAt: new Date().toISOString(), companyId: CO, payload };
}

/** A marketing request from the client's campaign, from the client's provider address, with its own unsubscribe link. */
export function marketing(overrides: Partial<MailSendRequested> = {}): MailSendRequested {
  return {
    key: "campaigns:step:e1:1",
    from: FROM,
    fromName: "Client Co",
    to: [{ email: "ann@x.co", name: "Ann" }],
    subject: "Spring offer",
    text: "Hi Ann",
    html: "<p>Hi Ann</p>",
    unsubscribeUrl: "https://paperclip.example.com/unsub?t=abc",
    context: { plugin: PIB_PLUGINS.campaigns, kind: "campaign_step", id: "e1", clientKind: CLIENT.kind, clientRef: CLIENT.ref },
    labels: ["PiB/Campaigns"],
    marketing: true,
    ...overrides,
  };
}

/** A transactional request (an invoice): no unsubscribe, no marketing. */
export function invoice(overrides: Partial<MailSendRequested> = {}): MailSendRequested {
  return {
    key: "billing:invoice:inv-1:send",
    to: [{ email: "ann@x.co" }],
    subject: "Invoice INV-1",
    text: "Attached",
    context: { plugin: PIB_PLUGINS.billing, kind: "invoice", id: "inv-1" },
    ...overrides,
  };
}

/** The headers Svix would send for a delivery, signed with `secret`. */
export function svixHeaders(rawBody: string, options: { id?: string; secret?: string; timestamp?: number } = {}): Record<string, string> {
  const id = options.id ?? "msg_1";
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  return { "svix-id": id, "svix-timestamp": String(timestamp), "svix-signature": signSvix(options.secret ?? WEBHOOK_SECRET, id, timestamp, rawBody) };
}

/** A Resend webhook body about a message we sent. */
export function eventBody(type: string, data: Record<string, unknown> = {}, extra: { createdAt?: string } = {}): string {
  return JSON.stringify({ type, created_at: extra.createdAt ?? new Date().toISOString(), data: { email_id: "mock-0001", from: `Client Co <${FROM}>`, to: ["ann@x.co"], subject: "Spring offer", tags: { pib_company: CO }, ...data } });
}

export async function knownToWebhook(ctx: Pick<EspCtx, "host">): Promise<void> {
  await rememberCompany(ctx.host.ctx, CO);
}

export const results = (emitted: Array<{ name: string; payload: Record<string, unknown> }>) => emitted.filter((e) => e.name === MAIL_EVENTS.sendResult).map((e) => e.payload);
