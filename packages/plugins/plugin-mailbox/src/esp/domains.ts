/**
 * Per-client sending domains: registering one at the email provider, handing the DNS records to whoever controls the DNS,
 * and bringing the send-only account up when the provider has verified the domain.
 *
 * A client's mail goes out as the client's own verified domain (`updates.client.co.za`), signed with its own DKIM key,
 * so the client's reputation is the client's and an opt-out or a complaint lands on the client's list. The flow:
 *
 * 1. `addSendingDomain` (the tool `add-sending-domain`, or a person on the Mailbox page) registers the domain at the
 *    provider, stores the records the provider asked for, and creates a send-only account (`provider` = the configured provider's key, status
 *    `pending`) for the From address. It returns the EXACT records to add, in order, and who adds them. **DNS is never
 *    edited by an agent**: the records go to the owner, or the client or their web host, in one ask.
 * 2. The Mailbox asks the provider to look at the DNS again every hour (and when `check-sender-domain` runs) and reads
 *    the domain's status. When the provider says `verified` the account becomes `connected` and sends are allowed.
 * 3. The existing domain check (SPF, DKIM, DMARC) confirms the records from the outside, judged on what the provider needs
 *    (`domain-health.ts`), and watches the domain every day from then on.
 *
 * At most 25 provider domains per company, so an agent cannot fill the provider account with domains.
 */
import { randomUUID } from "node:crypto";
import { loadMailboxConfig, type EspConfig, type LoadedConfig } from "../config.js";
import { organizationalDomain, sendingDomain } from "../dns.js";
import { checkAndStore, defaultResolver, sendingDomains, type DomainReport, type DomainRunEnv } from "../domain-health.js";
import { MailboxError } from "../domain.js";
import { isFreeMailDomain } from "../free-mail.js";
import { errorMessage, type Env } from "../gmail/env.js";
import { isValidEmail } from "../gmail/headers.js";
import type { AccountRow } from "../gmail/types.js";
import { cleanDisplayName } from "../sender.js";
import { hostInZone } from "./resend.js";
import { espProviderFor, noteEspState } from "./runtime.js";
import { EspApiError, type DnsRecord, type EspDomainRow, type ProviderDomain } from "./types.js";
import { clearanceOf, dailyCap, utcDay, reputationOf, REPUTATION_WINDOW_DAYS, DAY_MS, type DailyCap, type ReputationReport } from "./warmup.js";

export const MAX_ESP_DOMAINS = 25;
/** Verification is asked for at most this often per domain (the provider marks the domain pending each time). */
export const VERIFY_EVERY_MS = 6 * 3_600_000;
/** Domains looked at per hourly run. */
const REFRESH_PER_RUN = 10;

/** Records that are only needed when the owner switched open and click tracking on, which the Mailbox does not. */
const OPTIONAL_RECORDS = new Set(["TRACKING", "RECEIVING"]);

export function requiredRecords(records: DnsRecord[]): DnsRecord[] {
  return records.filter((record) => !OPTIONAL_RECORDS.has(record.record.toUpperCase()));
}

export interface DnsInstruction {
  type: DnsRecord["type"];
  /** The full host. */
  host: string;
  /** The host to type when the zone is the registered domain (`send.updates` in the zone `client.co.za`). */
  hostInZone: string;
  value: string;
  priority: number | null;
  purpose: string;
  /** The provider's verification status of this record. */
  status: string;
}

export interface DnsInstructions {
  domain: string;
  /** The zone the records are added in, best guess (the registered domain). */
  zone: string;
  records: DnsInstruction[];
  /** The DMARC record to add when the domain has none (an optional extra, not the provider's). */
  dmarc: DnsInstruction | null;
  steps: string[];
  whoAddsIt: string;
  afterwards: string;
}

/** The records somebody adds, in order, with the words to hand them over. DNS is edited by a person, never by an agent. */
export function dnsInstructions(row: Pick<EspDomainRow, "domain" | "records" | "status">, options: { report?: Pick<DomainReport, "dmarc"> | null; reportsMailbox?: string | null } = {}): DnsInstructions {
  const zone = organizationalDomain(row.domain);
  const records: DnsInstruction[] = requiredRecords(row.records).map((record) => ({
    type: record.type,
    host: record.fqdn,
    hostInZone: hostInZone(record.fqdn, row.domain),
    value: record.value,
    priority: record.priority,
    purpose: record.purpose,
    status: record.status,
  }));
  // A domain with no DMARC of its own (or inherited) should have one: start at p=none and read the reports.
  const needsDmarc = options.report ? options.report.dmarc.state === "missing" : false;
  const dmarc: DnsInstruction | null = needsDmarc
    ? {
      type: "TXT",
      host: `_dmarc.${row.domain}`,
      hostInZone: hostInZone(`_dmarc.${row.domain}`, row.domain),
      value: `v=DMARC1; p=none; rua=mailto:${options.reportsMailbox ?? `dmarc@${zone}`}`,
      priority: null,
      purpose: "DMARC: asks receivers for reports and ties SPF and DKIM to the From address. Start at p=none; raise it after about two weeks of clean reports.",
      status: "not_started",
    }
    : null;
  const lines = [...records, ...(dmarc ? [dmarc] : [])].map((record, index) => `${index + 1}. ${record.type} record at ${record.host}${record.hostInZone !== record.host ? ` (in the ${zone} zone: ${record.hostInZone})` : ""}${record.priority != null ? `, priority ${record.priority}` : ""}: ${record.value}`);
  return {
    domain: row.domain,
    zone,
    records,
    dmarc,
    steps: records.length === 0
      ? ["The provider has not listed any records yet; check the domain again in a minute."]
      : [`At the DNS host for ${zone}, add ${lines.length === 1 ? "this record" : `these ${lines.length} records`}, exactly as written (a record that already exists is edited, never duplicated):`, ...lines, "Save. DNS changes can take a few hours to show."],
    whoAddsIt: `Whoever controls the DNS of ${zone}: the owner, or the client or their web host. An agent cannot edit DNS, so hand them these steps in one partnersinbiz.cockpit:ask-owner and wait.`,
    afterwards: "Once the records are in, the provider verifies the domain by itself (the Mailbox asks it to look again every hour, and check-sender-domain does so now). The send-only account then becomes ready, the daily domain check watches the domain, and mail can go out as the client.",
  };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export interface SendingDomainView {
  domain: string;
  status: EspDomainRow["status"];
  /** The provider has verified the domain and the account is connected: mail may go out. */
  ready: boolean;
  account: { id: string; address: string; fromName: string | null; replyTo: string | null; status: string } | null;
  client: { kind: string; ref: string; name: string | null } | null;
  region: string | null;
  verifiedAt: string | null;
  checkedAt: string | null;
  firstSentAt: string | null;
  cap: DailyCap & { sentToday: number; remaining: number };
  reputation: ReputationReport | null;
  /** What the provider last said about tracking for this domain (null: not read yet). A client message is refused through a domain with either on. */
  tracking: { open: boolean | null; click: boolean | null };
  /** A person lifted the reputation hold: when, who (`user:<id>`) and the UTC day it counts from. */
  holdLifted: { at: string; by: string | null; day: string | null } | null;
  /** Records still to add (empty once verified). */
  dns: DnsInstructions | null;
}

export async function sendingDomainView(env: Pick<Env, "store" | "now">, config: Pick<EspConfig, "steadyDailyCap">, row: EspDomainRow, account: AccountRow | null, report: Pick<DomainReport, "dmarc"> | null = null): Promise<SendingDomainView> {
  const now = env.now();
  const today = utcDay(now);
  const days = await env.store.espDayRows(row.company_id, row.domain, utcDay(now - (REPUTATION_WINDOW_DAYS - 1) * DAY_MS)).catch(() => []);
  const sentToday = days.find((day) => day.day === today)?.sent ?? 0;
  const cap = dailyCap(row, config.steadyDailyCap, now);
  const ready = row.status === "verified" && account?.status === "connected";
  return {
    domain: row.domain,
    status: row.status,
    ready,
    account: account ? { id: account.id, address: account.address, fromName: account.from_name, replyTo: account.reply_to, status: account.status } : null,
    client: row.client_ref ? { kind: row.client_kind ?? "company", ref: row.client_ref, name: account?.from_name ?? null } : null,
    region: row.region,
    verifiedAt: row.verified_at,
    checkedAt: row.checked_at,
    firstSentAt: row.first_sent_at,
    cap: { ...cap, sentToday, remaining: Math.max(0, cap.cap - sentToday) },
    reputation: days.length > 0 ? reputationOf(days, row.domain, now, clearanceOf(row)) : null,
    tracking: { open: row.open_tracking ?? null, click: row.click_tracking ?? null },
    holdLifted: row.reputation_cleared_at ? { at: row.reputation_cleared_at, by: row.reputation_cleared_by ?? null, day: row.reputation_cleared_day ?? null } : null,
    dns: row.status === "verified" ? null : dnsInstructions(row, { report }),
  };
}

// ---------------------------------------------------------------------------
// Adding a domain
// ---------------------------------------------------------------------------

export interface AddSendingDomainInput {
  domain: string;
  /** The From address; default `hello@<domain>`. Must be on the domain. */
  fromAddress?: string | null;
  fromName?: string | null;
  /** Where replies go: a send-only address has no inbox, so this should be a mailbox somebody reads (the client's own). */
  replyTo?: string | null;
  clientKind?: "company" | "contact" | null;
  clientRef?: string | null;
  region?: string | null;
  createdBy: string;
  /** Where the owner finds the settings and what address the webhook points at, for the steps an unready provider needs. */
  ownerLinks?: { settings: string; webhookUrl: string | null };
}

/** What to tell the owner when the provider is not ready: the steps, in order, with where each is done. */
export function ownerSteps(config: EspConfig, links: { settings: string; webhookUrl: string | null }): string[] {
  return config.provider === "ses" ? sesOwnerSteps(config, links) : resendOwnerSteps(config, links);
}

/** The company's provider, in words for an error: "Resend" or "Amazon SES". */
export const providerName = (key: string): string => (key === "ses" ? "Amazon SES" : key === "resend" ? "Resend" : key);

/** Amazon SES: the steps are done in the AWS console by a person (the wording is refined with the surfaces in T3). */
function sesOwnerSteps(config: EspConfig, links: { settings: string; webhookUrl: string | null }): string[] {
  const steps: string[] = [];
  if (!config.hasCredentials) {
    steps.push(
      `In the AWS console (region ${config.ses.region}) create an IAM user with an access key that may call SES (send, GetAccount and the email identity calls).`,
      `Open the Mailbox settings (${links.settings}), find Email provider, pick Amazon SES, create Paperclip secrets for the access key id and the secret access key and pick them under Amazon SES, and switch the provider on.`,
    );
  } else if (!config.enabled) {
    steps.push(`Open the Mailbox settings (${links.settings}), find Email provider and switch it on.`);
  }
  if (!config.ses.configurationSet) {
    steps.push(`In the SES console create a configuration set with an event destination (an SNS topic) for the send, delivery, bounce, complaint and reject events, and save its name in the Mailbox settings (${links.settings}) under Amazon SES.`);
  }
  return steps;
}

function resendOwnerSteps(config: EspConfig, links: { settings: string; webhookUrl: string | null }): string[] {
  const steps: string[] = [];
  if (!config.hasCredentials) {
    steps.push(
      "Create a Resend account at https://resend.com/signup (or sign in at https://resend.com/login).",
      "Create an API key with Full access at https://resend.com/api-keys (Full access is needed to add domains as well as send).",
      `Open the Mailbox settings (${links.settings}), find Email provider, pick or create a Paperclip secret holding that key under Resend API key, and switch the provider on.`,
    );
  } else if (!config.enabled) {
    steps.push(`Open the Mailbox settings (${links.settings}), find Email provider and switch it on.`);
  }
  if (!config.hasWebhookSecret) {
    steps.push(
      `At https://resend.com/webhooks click Add Webhook, set the Endpoint URL to ${links.webhookUrl ?? "<your Paperclip public address>/api/plugins/partnersinbiz.mailbox/webhooks/resend"}, tick email.delivered, email.bounced, email.complained, email.delivery_delayed, email.failed, email.opened, email.clicked, email.suppressed and domain.updated, and save.`,
      `Copy the webhook's Signing Secret (it starts with whsec_), create a Paperclip secret for it, and pick it under Resend webhook signing secret in the Mailbox settings (${links.settings}). Click Save Configuration.`,
    );
  }
  return steps;
}

async function domainEnv(env: Env): Promise<DomainRunEnv> {
  return { ctx: env.ctx, store: env.store, dns: env.dns ?? defaultResolver(env.ctx), now: env.now };
}

/** Brings an account's status in line with its domain: connected once the provider has verified it. */
async function syncAccountStatus(env: Pick<Env, "store">, row: EspDomainRow): Promise<AccountRow | null> {
  if (!row.account_id) return null;
  const account = await env.store.getAccount(row.company_id, row.account_id);
  if (!account || account.status === "disconnected") return account;
  const want = row.status === "verified" ? "connected" : "pending";
  if (account.status !== want) {
    await env.store.setAccountStatus(row.company_id, account.id, want);
    return { ...account, status: want };
  }
  return account;
}

function fromProvider(row: EspDomainRow, domain: ProviderDomain, nowIso: string): EspDomainRow {
  return {
    ...row,
    provider_domain_id: domain.id,
    region: domain.region ?? row.region,
    status: domain.status,
    records: domain.records.length > 0 ? domain.records : row.records,
    return_path_host: domain.returnPathHost ?? row.return_path_host,
    dkim_selector: domain.dkimSelector ?? row.dkim_selector,
    spf_include: domain.spfInclude ?? row.spf_include,
    // Exactly what the provider said: not told is null, never "off".
    open_tracking: domain.openTracking ?? null,
    click_tracking: domain.clickTracking ?? null,
    verified_at: domain.status === "verified" ? row.verified_at ?? nowIso : row.verified_at,
    checked_at: nowIso,
  };
}

/** Registers a sending domain (or returns the one that exists) and creates its send-only account. Throws `MailboxError` with the fix. */
export async function addSendingDomain(env: Env, companyId: string, input: AddSendingDomainInput): Promise<{ created: boolean; view: SendingDomainView; report: DomainReport | null }> {
  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const domain = sendingDomain(input.domain);
  if (!domain) throw new MailboxError("domain is required, e.g. updates.client.co.za (use a subdomain: it keeps the client's reputation apart from the main domain's mail)");
  if (isFreeMailDomain(domain)) throw new MailboxError(`${domain} is a free mail service: the provider can only send as a domain you control.`);
  const provider = await espProviderFor(env, loaded, { forSending: false });
  if (!provider.ok) {
    const steps = ownerSteps(loaded.config.esp, input.ownerLinks ?? { settings: "Settings, Plugins, Mailbox", webhookUrl: null });
    throw new MailboxError(
      `The email provider is not ready: ${provider.blockers.join(" ")} An agent cannot create the ${providerName(loaded.config.esp.provider)} account or its ${loaded.config.esp.provider === "ses" ? "access keys" : "API key"}. Ask the owner ONCE (partnersinbiz.cockpit:ask-owner) to do these one-time steps, then run this again:${steps.map((step, index) => ` (${index + 1}) ${step}`).join("")}`,
    );
  }

  const s = env.store;
  const existing = await s.getEspDomain(companyId, domain);
  if (existing && existing.provider !== loaded.config.esp.provider) {
    throw new MailboxError(`${domain} is registered with ${providerName(existing.provider)}, but the Mailbox is set to ${providerName(loaded.config.esp.provider)}. Switch the provider back in the Mailbox settings to manage it, or ask the owner to move the domain.`);
  }
  if (existing?.client_ref && input.clientRef?.trim() && existing.client_ref !== input.clientRef.trim()) {
    throw new MailboxError(`${domain} already belongs to another client (${existing.client_kind ?? "company"}:${existing.client_ref}). A domain sends for one client only.`);
  }
  // The company's own domain is not a client's: giving it a client now would silently do nothing, so say so.
  if (existing && !existing.client_ref && input.clientRef?.trim()) {
    throw new MailboxError(`${domain} is already registered as the company's own sending domain, so it cannot also send for the client ${input.clientRef.trim()}. A domain sends for one client only (or for the company): give the client a subdomain of their own (for example updates.<their domain>) and add that.`);
  }
  const fromAddress = (input.fromAddress?.trim() || `hello@${domain}`).toLowerCase();
  if (!isValidEmail(fromAddress) || sendingDomain(fromAddress) !== domain) throw new MailboxError(`The From address ${fromAddress} must be an address at ${domain}.`);
  const replyTo = input.replyTo?.trim().toLowerCase() || null;
  if (replyTo && !isValidEmail(replyTo)) throw new MailboxError(`The reply-to address ${replyTo} is not an email address.`);
  if (replyTo === fromAddress) throw new MailboxError("The reply-to address must be somewhere somebody reads: a send-only address has no inbox.");
  const fromName = cleanDisplayName(input.fromName);

  // An existing domain keeps the client it was registered for.
  let clientKind: "company" | "contact" | null = existing?.client_ref ? ((existing.client_kind as "company" | "contact" | null) ?? "company") : null;
  let clientRef: string | null = existing?.client_ref ?? null;
  let clientName: string | null = null;
  if (!existing && input.clientRef?.trim()) {
    clientKind = input.clientKind === "contact" ? "contact" : "company";
    clientRef = input.clientRef.trim();
    const found = clientKind === "company" ? await s.crmCompany(companyId, clientRef) : await s.crmContact(companyId, clientRef);
    if (!found) throw new MailboxError(`The CRM has no ${clientKind} ${clientRef} in this company. Find the client with partnersinbiz.crm:find-records first.`);
    clientName = found.name;
  }

  if (!existing) {
    if ((await s.listEspDomains(companyId)).length >= MAX_ESP_DOMAINS) throw new MailboxError(`${MAX_ESP_DOMAINS} sending domains are already registered. Ask the owner to clean up before adding another.`);
    const taken = (await s.listAccounts(companyId)).find((account) => account.address.toLowerCase() === fromAddress);
    if (taken) throw new MailboxError(`${fromAddress} is already a mailbox in this company. Pick another From address on ${domain} (for example updates@${domain}).`);
  }

  // The provider: a domain the owner already added in the dashboard is adopted, never registered twice.
  let remote: ProviderDomain;
  if (existing) {
    try {
      remote = await provider.provider.getDomain(existing.provider_domain_id);
    } catch (error) {
      throw wrap(error, "read the domain");
    }
  } else {
    try {
      remote = await provider.provider.addDomain({ name: domain, region: input.region ?? null });
    } catch (error) {
      if (error instanceof EspApiError && error.kind === "exists") {
        try {
          const listed = (await provider.provider.listDomains()).find((entry) => entry.name === domain);
          if (!listed) throw new MailboxError(`${providerName(loaded.config.esp.provider)} says ${domain} is registered, but not under these credentials. Remove it from the other account, or use that account's keys.`);
          remote = await provider.provider.getDomain(listed.id);
        } catch (inner) {
          if (inner instanceof MailboxError) throw inner;
          throw wrap(inner, "adopt the domain");
        }
      } else {
        throw wrap(error, "add the domain");
      }
    }
  }
  await noteEspState(env.ctx, companyId, { code: null }, env.now());

  const nowIso = new Date(env.now()).toISOString();
  const base: EspDomainRow = existing ?? {
    company_id: companyId,
    domain,
    provider: loaded.config.esp.provider,
    provider_domain_id: remote.id,
    region: remote.region,
    status: remote.status,
    records: remote.records,
    return_path_host: remote.returnPathHost,
    dkim_selector: remote.dkimSelector,
    spf_include: remote.spfInclude,
    client_kind: clientKind,
    client_ref: clientRef,
    account_id: null,
    created_by: input.createdBy,
    verified_at: null,
    checked_at: nowIso,
    verify_asked_at: null,
    first_sent_at: null,
    last_sent_at: null,
    warmup_exempt: false,
    daily_cap_override: null,
    reputation: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
  const row = fromProvider(base, remote, nowIso);
  await s.upsertEspDomain(row);

  // The send-only account (one per domain). A domain that already has one keeps it.
  let account = row.account_id ? await s.getAccount(companyId, row.account_id) : null;
  if (!account) {
    const id = randomUUID();
    try {
      await s.insertEspAccount({ id, companyId, provider: loaded.config.esp.provider, address: fromAddress, status: row.status === "verified" ? "connected" : "pending", fromName: fromName ?? clientName, replyTo, clientKind, clientRef, createdBy: input.createdBy });
    } catch (error) {
      // The unique index on a company's send-only addresses: another add-sending-domain for this domain got there first.
      if (/accounts_(resend|ses)_address|duplicate key|unique/i.test(errorMessage(error))) throw new MailboxError(`Another add-sending-domain for ${domain} has just created ${fromAddress}. Run list-sending-domains to see it, and add-sending-domain again if it is not there.`);
      throw error;
    }
    await s.patchEspDomain(companyId, domain, { account_id: id });
    account = await s.getAccount(companyId, id);
    row.account_id = id;
  } else if (replyTo) {
    await s.setAccountReplyTo(companyId, account.id, replyTo);
  }
  account = account ? ((await syncAccountStatus(env, { ...row, account_id: account.id })) ?? account) : null;

  // Read the DNS now: it is watched every day from here, and the first answer says which records are still missing.
  let report: DomainReport | null = null;
  try {
    const target = (await sendingDomains(s, companyId)).find((entry) => entry.domain === domain);
    if (target) report = await checkAndStore(await domainEnv(env), companyId, target, { selectors: loaded.config.dkimSelectors });
  } catch (error) {
    env.ctx.logger.info("Sending domain DNS check skipped", { domain, error: errorMessage(error) });
  }
  const fresh = (await s.getEspDomain(companyId, domain)) ?? row;
  return { created: !existing, view: await sendingDomainView(env, loaded.config.esp, fresh, account, report), report };
}

function wrap(error: unknown, doing: string): MailboxError {
  if (error instanceof MailboxError) return error;
  if (error instanceof EspApiError) return new MailboxError(`Could not ${doing}: ${error.message}`);
  return new MailboxError(`Could not ${doing}: ${errorMessage(error)}`);
}

// ---------------------------------------------------------------------------
// Refreshing
// ---------------------------------------------------------------------------

export interface RefreshOutcome {
  domain: string;
  status: EspDomainRow["status"];
  becameVerified: boolean;
  /** Verification was asked for this time. */
  asked: boolean;
}

/**
 * Reads the provider's status of one domain, asking it to look at the DNS again when it has not been asked in the last six
 * hours (or `force`). A domain that became verified brings its account up and is checked from the outside straight away.
 */
export async function refreshSendingDomain(env: Env, loaded: LoadedConfig, companyId: string, domain: string, options: { verify?: boolean; force?: boolean } = {}): Promise<RefreshOutcome> {
  const s = env.store;
  const row = await s.getEspDomain(companyId, domain);
  if (!row) throw new MailboxError(`${domain} is not a sending domain of the email provider. add-sending-domain registers it.`);
  const provider = await espProviderFor(env, loaded, { forSending: false });
  if (!provider.ok) throw new MailboxError(`The email provider is not ready: ${provider.blockers.join(" ")}`);
  // A domain registered with the other provider is not asked about at this one (SES would not know it).
  if (row.provider !== loaded.config.esp.provider) throw new MailboxError(`${domain} is registered with ${providerName(row.provider)}, not ${providerName(loaded.config.esp.provider)}, which the Mailbox is set to.`);
  const now = env.now();
  let asked = false;
  try {
    if (options.verify !== false && row.status !== "verified" && (options.force || !row.verify_asked_at || now - Date.parse(row.verify_asked_at) >= VERIFY_EVERY_MS)) {
      await provider.provider.verifyDomain(row.provider_domain_id);
      await s.patchEspDomain(companyId, domain, { verify_asked_at: new Date(now).toISOString() });
      asked = true;
    }
    const remote = await provider.provider.getDomain(row.provider_domain_id);
    const next = fromProvider(row, remote, new Date(now).toISOString());
    await s.upsertEspDomain(next);
    await noteEspState(env.ctx, companyId, { code: null }, now);
    const becameVerified = row.status !== "verified" && next.status === "verified";
    await syncAccountStatus(env, next);
    // The provider's verification and the DNS seen from outside agree (or say why not) as soon as the domain changes state.
    if (becameVerified || row.status !== next.status) {
      try {
        const target = (await sendingDomains(s, companyId)).find((entry) => entry.domain === domain);
        if (target) await checkAndStore(await domainEnv(env), companyId, target, { selectors: loaded.config.dkimSelectors });
      } catch (error) {
        env.ctx.logger.info("Sending domain DNS check skipped", { domain, error: errorMessage(error) });
      }
    }
    return { domain, status: next.status, becameVerified, asked };
  } catch (error) {
    if (error instanceof EspApiError && error.kind === "config") await noteEspState(env.ctx, companyId, { code: "key_refused", detail: error.message }, now);
    throw wrap(error, "read the domain");
  }
}

/** Hourly: every provider domain that is not verified yet is looked at again. Returns how many became verified. */
export async function refreshPendingDomains(env: Env, companyId: string): Promise<{ looked: number; verified: number }> {
  const loaded = await loadMailboxConfig(env.ctx, companyId);
  const result = { looked: 0, verified: 0 };
  if (!loaded.config.esp.enabled || !loaded.config.esp.hasCredentials) return result;
  const pending = (await env.store.listEspDomains(companyId)).filter((row) => row.status !== "verified" && row.provider === loaded.config.esp.provider).slice(0, REFRESH_PER_RUN);
  for (const row of pending) {
    try {
      const outcome = await refreshSendingDomain(env, loaded, companyId, row.domain);
      result.looked += 1;
      if (outcome.becameVerified) result.verified += 1;
    } catch (error) {
      env.ctx.logger.info("Sending domain refresh failed", { companyId, domain: row.domain, error: errorMessage(error) });
    }
  }
  return result;
}

