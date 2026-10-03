/**
 * Small readers the client care features share: who a client is, which of its
 * people can be written to, and which clients the monthly jobs act for.
 * Jobs and tools use these directly (no viewer): a job acts for the company, a
 * tool has already checked that the client is visible (`requireClient`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isCanaryAccount, isCanaryContact, isCanaryEmail } from "./canary-flag.js";
import type { ClientKey } from "./care-store.js";
import { getAccount, getContact, insertActivityOnce, listAccounts, listContacts, listLinks } from "./db.js";
import { CrmError, type ContactDraft } from "./domain.js";
import { clientProjectIds, getClientProfile } from "./store.js";

export interface ClientInfo {
  key: ClientKey;
  name: string;
  lifecycle: string;
  tags: string[];
  custom: Record<string, unknown>;
  website: string | null;
  canary: boolean;
}

/** Tags that mark a client the monthly jobs must leave alone: our own apps, internal projects and the canary. */
const INTERNAL_TAGS = ["own-app", "internal", "canary"];

/** A client the automatic jobs (reports, health alerts) skip: ours, internal, or the canary. */
export function isInternalClient(info: Pick<ClientInfo, "tags" | "custom" | "canary">): boolean {
  return info.canary || info.custom.ownApp === true || info.tags.some((tag) => INTERNAL_TAGS.includes(tag.toLowerCase()));
}

export async function clientInfo(ctx: PluginContext, companyId: string, client: ClientKey): Promise<ClientInfo | null> {
  if (client.kind === "company") {
    const account = await getAccount(ctx, client.id);
    if (!account || account.companyId !== companyId) return null;
    return { key: client, name: account.name, lifecycle: account.lifecycle, tags: account.tags, custom: account.custom, website: account.domain ?? null, canary: isCanaryAccount(account) };
  }
  const contact = await getContact(ctx, client.id);
  if (!contact || contact.companyId !== companyId) return null;
  return { key: client, name: contact.name, lifecycle: contact.lifecycle, tags: contact.tags, custom: contact.custom, website: null, canary: isCanaryContact(contact) };
}

/** The people of a client with their records: a company's linked contacts, or the contact itself (a sole trader). */
export async function clientContacts(ctx: PluginContext, companyId: string, client: ClientKey): Promise<ContactDraft[]> {
  if (client.kind === "contact") {
    const contact = await getContact(ctx, client.id);
    return contact && contact.companyId === companyId ? [contact] : [];
  }
  const links = (await listLinks(ctx, companyId)).filter((link) => link.accountId === client.id);
  if (links.length === 0) return [];
  const ids = new Set(links.map((link) => link.contactId));
  return (await listContacts(ctx, companyId)).filter((contact) => contact.companyId === companyId && ids.has(contact.id));
}

export function primaryEmail(contact: Pick<ContactDraft, "emails">): string | null {
  return contact.emails.find((email) => email.includes("@")) ?? null;
}

/**
 * The person a client request is written to: the contact named, else the address named (it must be one of the client's people),
 * else the client's first person with a working address. Never an address that is not on the client, so a request cannot be
 * pointed at a stranger.
 */
export async function pickRecipient(
  ctx: PluginContext,
  companyId: string,
  client: ClientKey,
  params: { contactId?: string | null; toEmail?: string | null },
): Promise<{ contact: ContactDraft; email: string }> {
  const people = await clientContacts(ctx, companyId, client);
  if (people.length === 0) throw new CrmError("This client has no contact with an email address. Add one with create-contact and link-contact first.");
  const wantedId = params.contactId?.trim().replace(/^contact:/, "") || null;
  const wantedEmail = params.toEmail?.trim().toLowerCase() || null;
  let contact: ContactDraft | undefined;
  if (wantedId) {
    contact = people.find((person) => person.id === wantedId);
    if (!contact) throw new CrmError("That contact is not one of this client's people. Pick one from get-company (contacts).");
  } else if (wantedEmail) {
    contact = people.find((person) => person.emails.some((email) => email.trim().toLowerCase() === wantedEmail));
    if (!contact) throw new CrmError("That address is not on any of this client's people, so nothing is drafted to it. Add the person to the client first.");
  } else {
    contact = people.find((person) => primaryEmail(person) && person.emailStatus !== "bounced" && !isCanaryOnly(person)) ?? people.find((person) => primaryEmail(person));
  }
  const email = contact ? (wantedEmail && contact.emails.some((item) => item.trim().toLowerCase() === wantedEmail) ? wantedEmail : primaryEmail(contact)) : null;
  if (!contact || !email) throw new CrmError("The contact has no email address.");
  if (contact.emailStatus === "bounced") throw new CrmError(`${email} bounced before. Fix the address (update-contact) or ask for another contact.`);
  return { contact, email };
}

function isCanaryOnly(contact: ContactDraft): boolean {
  return contact.emails.length > 0 && contact.emails.every(isCanaryEmail);
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** The kind of the timeline entries the care features write themselves: not work a person did, so no check counts them as follow-up. */
export const CARE_EVENT_KIND = "care_event";

/**
 * A line on the client's timeline for something the care features did (a request prepared, a report sent, a case opened), once
 * per source key (a retried job never logs it twice). It is stored as a `care_event`, never as a note or an email: a done-check
 * that asks whether someone followed up must not be satisfied by the system's own bookkeeping. `what` says what it was.
 */
export async function logOnClient(ctx: PluginContext, companyId: string, client: ClientKey, what: string, body: string, sourceKey: string, issueId: string | null = null): Promise<void> {
  await insertActivityOnce(ctx, { companyId, recordType: client.kind, recordId: client.id, kind: CARE_EVENT_KIND, body: body.slice(0, 1000), sourceKey, issueId, meta: { what } }).catch(() => false);
}

/**
 * Every customer of a company, as a client: companies with lifecycle customer, and contacts with lifecycle customer who work for
 * no company (sole traders). Leads, prospects and churned clients are not customers.
 */
export async function customerClients(ctx: PluginContext, companyId: string): Promise<ClientInfo[]> {
  const [accounts, contacts, links] = await Promise.all([listAccounts(ctx, companyId), listContacts(ctx, companyId), listLinks(ctx, companyId)]);
  const linked = new Set(links.map((link) => link.contactId));
  const out: ClientInfo[] = [];
  for (const account of accounts) {
    if (account.companyId !== companyId || account.lifecycle !== "customer") continue;
    out.push({ key: { kind: "company", id: account.id }, name: account.name, lifecycle: account.lifecycle, tags: account.tags, custom: account.custom, website: account.domain ?? null, canary: isCanaryAccount(account) });
  }
  for (const contact of contacts) {
    if (contact.companyId !== companyId || contact.lifecycle !== "customer" || linked.has(contact.id)) continue;
    out.push({ key: { kind: "contact", id: contact.id }, name: contact.name, lifecycle: contact.lifecycle, tags: contact.tags, custom: contact.custom, website: null, canary: isCanaryContact(contact) });
  }
  return out;
}

/** True when a client has anything the care jobs could report on: a service on its profile (the service vocabulary). */
export async function hasActiveService(ctx: PluginContext, companyId: string, client: ClientKey): Promise<boolean> {
  const profile = await getClientProfile(ctx, companyId, client.kind, client.id).catch(() => null);
  return Boolean(profile && profile.services.length > 0);
}

/** The client's own Paperclip project (client work lives there, never in our own), or null when none is linked. */
export async function clientProjectOf(ctx: PluginContext, companyId: string, client: ClientKey): Promise<string | null> {
  try {
    return (await clientProjectIds(ctx, companyId, client.kind, client.id))[0] ?? null;
  } catch {
    return null;
  }
}
