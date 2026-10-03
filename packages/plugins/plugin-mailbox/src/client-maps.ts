/**
 * Client mail mappings (Q1a-9 part b): forwarded or BCC'd client mail is the
 * client's, not the company's own.
 *
 * The live case: the AHS Law website form was BCC'd to a PiB mailbox, and the
 * Mailbox filed each submission as PiB's own lead (`clientKind: null` is
 * hard-coded for our mailboxes, because our own accounts are our own). The
 * client's lead was misfiled three times and left no spam protection.
 *
 * A mapping says which client a sender or recipient belongs to:
 * - `sender_domain` / `sender_address`: mail FROM the client's site or system
 *   (a website form relayed by the web host). The visitor is in Reply-To.
 * - `recipient_domain` / `recipient_address`: mail TO the client's address or
 *   an alias we forward (a BCC copy, `leads+ahslaw@ourdomain`).
 *
 * With a match, the message is filed under that client (`client_kind` and
 * `client_ref`, triage source `mapping`) and a lead from it goes to the CRM in
 * the client's scope (`lead.captured` with `clientKind`/`clientRef`), with the
 * visitor from Reply-To as the person. Without a match nothing changes: it
 * stays the company's own, and when it looks like a client's (a form relay, or
 * a client domain in the CRM) it is flagged `needs_mapping` so a person or the
 * Account Manager can add the mapping once, from the Mailbox page or the
 * `map-client-mail` tool. Adding a mapping also files the flagged mail of the
 * last 30 days and re-sends those leads in the client's scope.
 */
import { HANDOFF_EVENTS, enqueue, type MailAddress } from "@partnersinbiz/pib-plugin-kit";
import { sendingDomain } from "./dns.js";
import type { GmailStore } from "./db.js";
import { MailboxError } from "./domain.js";
import { errorMessage, type Env } from "./gmail/env.js";
import { isValidEmail, normaliseEmail } from "./gmail/headers.js";
import { bySender, leadCapturedFrom, relayedPerson } from "./gmail/leads.js";
import { isFreeMailDomain } from "./free-mail.js";
import type { ClientMapRow, ClientMapType, MessageRow, StoredTriage } from "./gmail/types.js";

export const MAP_TYPES: readonly ClientMapType[] = ["sender_domain", "sender_address", "recipient_domain", "recipient_address"];

export const MAP_TYPE_LABELS: Record<ClientMapType, string> = {
  sender_domain: "Mail from this domain",
  sender_address: "Mail from this address",
  recipient_domain: "Mail to this domain",
  recipient_address: "Mail to this address",
};

/** Higher wins when several mappings match one message: a specific address beats a domain, the sender beats the recipient. */
const PRECEDENCE: Record<ClientMapType, number> = { sender_address: 4, recipient_address: 3, sender_domain: 2, recipient_domain: 1 };

export function isMapType(value: unknown): value is ClientMapType {
  return typeof value === "string" && (MAP_TYPES as readonly string[]).includes(value);
}

/** The pattern a mapping stores, or null when it is not usable for that type. */
export function normalisePattern(type: ClientMapType, raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (type === "sender_address" || type === "recipient_address") return isValidEmail(text) ? normaliseEmail(text) : null;
  const domain = sendingDomain(text.replace(/^@/, ""));
  return domain && domain.includes(".") ? domain : null;
}

export interface MailFacts {
  from: string | null;
  recipients: string[];
}

export function factsOf(row: Pick<MessageRow, "from_addr" | "to_addrs" | "cc_addrs" | "bcc_addrs">): MailFacts {
  const emails = (list: MailAddress[] | null | undefined) => (list ?? []).map((a) => a.email.toLowerCase());
  return { from: row.from_addr?.email?.toLowerCase() ?? null, recipients: [...emails(row.to_addrs), ...emails(row.cc_addrs), ...emails(row.bcc_addrs)] };
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1);
/** A domain rule covers the domain and its subdomains. */
const inDomain = (host: string, pattern: string) => host === pattern || host.endsWith(`.${pattern}`);

function matches(map: ClientMapRow, facts: MailFacts): boolean {
  switch (map.match_type) {
    case "sender_address": return facts.from === map.pattern;
    case "sender_domain": return facts.from !== null && inDomain(domainOf(facts.from), map.pattern);
    case "recipient_address": return facts.recipients.includes(map.pattern);
    case "recipient_domain": return facts.recipients.some((email) => inDomain(domainOf(email), map.pattern));
  }
}

/** The mapping that applies to a message, or null. A specific address beats a domain; the sender beats the recipient; then the longest pattern. */
export function matchClientMap(maps: ClientMapRow[], facts: MailFacts, ownAddresses: ReadonlySet<string> = new Set()): ClientMapRow | null {
  // Our own mailbox addresses are never a recipient that proves anything: every message is "to" one of them.
  const scoped: MailFacts = { ...facts, recipients: facts.recipients.filter((email) => !ownAddresses.has(email)) };
  const hits = maps.filter((map) => matches(map, scoped));
  hits.sort((a, b) => PRECEDENCE[b.match_type] - PRECEDENCE[a.match_type] || b.pattern.length - a.pattern.length || a.created_at.localeCompare(b.created_at));
  return hits[0] ?? null;
}

const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|wordpress|wp|webmaster|website|web|forms?|contact|contactform|enquir(y|ies)|inquir(y|ies)|info|admin|mailer|system|notifications?|leads?|submissions?)$/;

/**
 * Whether unmapped mail looks like a client's: a form relayed by an automated
 * sender with the visitor in Reply-To, or a lead or client mail whose sender
 * domain is a client's domain in the CRM. Such mail stays the company's own and
 * is flagged for a mapping.
 */
export function looksLikeClientMail(row: Pick<MessageRow, "from_addr" | "reply_to_addr" | "bounce" | "bulk">, triage: Pick<StoredTriage, "category" | "clientRef" | "clientSource">): boolean {
  if (row.bounce || triage.category === "spam" || triage.category === "newsletter") return false;
  const local = row.from_addr?.email.split("@")[0]?.toLowerCase() ?? "";
  const domain = sendingDomain(row.from_addr?.email ?? null);
  if (!domain || isFreeMailDomain(domain)) return false;
  const relay = Boolean(relayedPerson(row)) && AUTOMATED_LOCAL.test(local);
  const clientDomain = triage.clientRef !== null && (triage.clientSource === "domain" || triage.clientSource === "jev") && (triage.category === "lead" || triage.category === "client");
  return relay || clientDomain;
}

// ---------------------------------------------------------------------------
// Managing mappings
// ---------------------------------------------------------------------------

export interface AddMapInput {
  matchType: ClientMapType;
  pattern: string;
  clientKind: "company" | "contact";
  clientRef: string;
  note?: string | null;
}

async function clientName(store: Pick<GmailStore, "crmCompany" | "crmContact">, companyId: string, kind: "company" | "contact", ref: string): Promise<string | null> {
  const found = kind === "company" ? await store.crmCompany(companyId, ref) : await store.crmContact(companyId, ref);
  return found ? found.name : null;
}

/**
 * Adds a mapping (the client must exist in the CRM, so a made-up reference is
 * refused) and files the flagged mail of the last 30 days under it. One rule
 * maps to one client: the same rule for another client is refused until the
 * first is removed. Returns the mapping and how many messages it filed.
 */
export async function addClientMap(env: Pick<Env, "ctx" | "store" | "now">, companyId: string, input: AddMapInput, createdBy: string | null): Promise<{ map: ClientMapRow; filed: number; rehanded: number }> {
  if (!isMapType(input.matchType)) throw new MailboxError(`matchType must be one of: ${MAP_TYPES.join(", ")}`);
  if (input.clientKind !== "company" && input.clientKind !== "contact") throw new MailboxError("clientKind must be company or contact");
  const pattern = normalisePattern(input.matchType, input.pattern);
  if (!pattern) throw new MailboxError(input.matchType.endsWith("domain") ? "pattern must be a domain such as ahslaw.co.za" : "pattern must be an email address");
  const own = await env.store.listAccounts(companyId);
  if (input.matchType.endsWith("domain")) {
    if (isFreeMailDomain(pattern)) throw new MailboxError(`${pattern} is a free mail domain used by everybody: map the exact address instead.`);
    if (own.some((account) => inDomain(domainOf(account.address.toLowerCase()), pattern) || inDomain(pattern, domainOf(account.address.toLowerCase())))) {
      throw new MailboxError(`${pattern} is the company's own domain, so a domain rule would claim all its mail. Map the exact alias address instead.`);
    }
  } else if (own.some((account) => account.address.toLowerCase() === pattern)) {
    throw new MailboxError(`${pattern} is one of this company's own mailboxes. Map an alias that forwards to it instead.`);
  }
  const name = await clientName(env.store, companyId, input.clientKind, input.clientRef);
  if (!name) throw new MailboxError(`The CRM has no ${input.clientKind} ${input.clientRef} in this company. Find the client with partnersinbiz.crm:find-records first.`);
  const existing = (await env.store.listClientMaps(companyId)).find((map) => map.match_type === input.matchType && map.pattern === pattern);
  if (existing && !(existing.client_kind === input.clientKind && existing.client_ref === input.clientRef)) {
    throw new MailboxError(`${MAP_TYPE_LABELS[input.matchType]} ${pattern} is already mapped to ${existing.client_name ?? existing.client_ref}. Remove that mapping first.`);
  }
  const map = existing ?? (await env.store.insertClientMap({ companyId, matchType: input.matchType, pattern, clientKind: input.clientKind, clientRef: input.clientRef, clientName: name, note: input.note?.trim().slice(0, 300) || null, createdBy }));
  const { filed, rehanded } = await fileFlaggedMail(env, companyId, map);
  return { map, filed, rehanded };
}

export async function removeClientMap(store: Pick<GmailStore, "deleteClientMap">, companyId: string, id: string): Promise<{ removed: boolean }> {
  return { removed: await store.deleteClientMap(companyId, id) };
}

/** Maps with the mail waiting for one: what the tool and the page show. */
export async function clientMapOverview(store: Pick<GmailStore, "listClientMaps" | "unmappedSummary">, companyId: string, days = 30) {
  const [maps, unmapped] = await Promise.all([store.listClientMaps(companyId), store.unmappedSummary(companyId, days)]);
  return {
    maps: maps.map((map) => ({ id: map.id, matchType: map.match_type, pattern: map.pattern, clientKind: map.client_kind, clientRef: map.client_ref, clientName: map.client_name, note: map.note, createdAt: map.created_at })),
    unmapped: unmapped.map((row) => ({ domain: row.domain, messages: Number(row.n), lastReceivedAt: row.last_at, sampleMessageId: row.sample_id })),
    days,
  };
}

// ---------------------------------------------------------------------------
// Filing mail
// ---------------------------------------------------------------------------

/** What a mapped message's triage client becomes. */
export function mappedClient(map: ClientMapRow): { kind: "company" | "contact"; id: string; name: string; source: "mapping" } {
  return { kind: map.client_kind, id: map.client_ref, name: map.client_name ?? "", source: "mapping" };
}

/** Files the flagged mail of the last 30 days under a new mapping and re-sends those leads in the client's scope. */
async function fileFlaggedMail(env: Pick<Env, "ctx" | "store" | "now">, companyId: string, map: ClientMapRow): Promise<{ filed: number; rehanded: number }> {
  let filed = 0;
  let rehanded = 0;
  const own = new Set((await env.store.listAccounts(companyId)).map((account) => account.address.toLowerCase()));
  for (const row of await env.store.flaggedMessages(companyId, 30, 200)) {
    if (matchClientMap([map], factsOf(row), own)?.id !== map.id) continue;
    const triage: StoredTriage = { ...(row.triage as StoredTriage), clientKind: map.client_kind, clientRef: map.client_ref, clientName: map.client_name, clientSource: "mapping", mapping: { id: map.id, type: map.match_type } };
    if (bySender(map.match_type) && relayedPerson(row) && triage.category !== "spam" && (triage.phishing ?? 0) < 0.9) triage.category = "lead";
    await env.store.setTriage(companyId, row.id, {
      triage,
      category: triage.category,
      urgency: triage.urgency,
      needsReply: triage.needsReply,
      phishing: triage.phishing,
      clientKind: map.client_kind,
      clientRef: map.client_ref,
      replyTo: row.reply_to,
      mapState: "mapped",
      mapId: map.id,
    });
    filed += 1;
    if (triage.category !== "lead" || !row.gmail_message_id) continue;
    try {
      const account = await env.store.getAccount(companyId, row.account_id);
      const lead = leadCapturedFrom({ ...row, triage }, account?.address ?? null, map);
      // A new key: the CRM already stored the first one as the company's own lead. `supersedes` names it.
      const key = `${lead.key}:client:${map.client_kind}:${map.client_ref}`;
      await enqueue(env.ctx, companyId, HANDOFF_EVENTS.leadCaptured, { ...lead, key, supersedes: lead.key } as unknown as { key: string } & Record<string, unknown>);
      rehanded += 1;
    } catch (error) {
      env.ctx.logger.info("Re-scoped lead not queued", { messageId: row.id, error: errorMessage(error) });
    }
  }
  return { filed, rehanded };
}
