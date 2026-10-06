/**
 * Read and search tools for agents: find a client, read its profile, people,
 * deals and recent activity, and keep the client profile (how to talk for
 * them). Results are compact and always carry the `company:<id>` /
 * `contact:<id>` ref and deep links.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  ensurePipeline,
  grantsFor,
  listAccounts,
  listActivities,
  listContacts,
  listDeals,
  listLinks,
  listSequences,
  listStages,
  listSteps,
  runningEnrollmentsForContact,
  sequenceDelivery,
  sequenceEmailApproved,
  stageKind,
  table,
} from "./db.js";
import { BILLING_KEYS, canSeeRecord, CrmError, DEAL_STATUSES, FIND_KINDS, FIND_MAX, LIFECYCLES, type AccountDraft, type ContactDraft, type DealDraft, type Lifecycle, type Viewer } from "./domain.js";
import { companyPrefix, crmLink, refOf, workspaceLinks, type ClientKind } from "./refs.js";
import { CANARY_RULES, isCanaryAccount, isCanaryContact, isCanaryId } from "./canary-flag.js";
import { consentSummary } from "./consent.js";
import { onServicesChanged } from "./service-onboarding.js";
import { diffServices, normalizeServices, SERVICE_KEYS } from "./services.js";
import {
  CORE_PROFILE_FIELDS,
  EMPTY_PROFILE,
  getClientProfile,
  listClientLeads,
  PROFILE_FIELDS,
  PROPOSAL_FIELDS,
  saveClientProfile,
  type ClientProfile,
  type ClientProfileRecord,
  type ProfileField,
} from "./store.js";


const clip = (value: string | null | undefined, max = 280): string => {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function digits(value: string): string {
  return value.replace(/\D+/g, "");
}

function bareDomain(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/** Every record this viewer may see (grants included). */
async function visible(ctx: PluginContext, viewer: Viewer) {
  const [accounts, contacts, deals, links] = await Promise.all([
    listAccounts(ctx, viewer.companyId),
    listContacts(ctx, viewer.companyId),
    listDeals(ctx, viewer.companyId),
    listLinks(ctx, viewer.companyId),
  ]);
  const [accountGrants, contactGrants, dealGrants] = await Promise.all([
    grantsFor(ctx, "company", viewer.companyId),
    grantsFor(ctx, "contact", viewer.companyId),
    grantsFor(ctx, "deal", viewer.companyId),
  ]);
  const visibleAccounts = accounts.filter((row) => canSeeRecord(viewer, row, accountGrants.get(row.id) ?? []));
  const visibleContacts = contacts.filter((row) => canSeeRecord(viewer, row, contactGrants.get(row.id) ?? []));
  const visibleDeals = deals.filter((row) => canSeeRecord(viewer, row, dealGrants.get(row.id) ?? []));
  const contactIds = new Set(visibleContacts.map((row) => row.id));
  return { accounts: visibleAccounts, contacts: visibleContacts, deals: visibleDeals, links: links.filter((link) => contactIds.has(link.contactId)) };
}

/** The clients this viewer may see, loaded once: for a list that must check many of them. */
export async function visibleClients(ctx: PluginContext, viewer: Viewer): Promise<{ has: (kind: ClientKind, id: string) => boolean }> {
  const records = await visible(ctx, viewer);
  const companies = new Set(records.accounts.map((row) => row.id));
  const contacts = new Set(records.contacts.map((row) => row.id));
  return { has: (kind, id) => (kind === "company" ? companies.has(id) : contacts.has(id)) };
}

async function stageMap(ctx: PluginContext, companyId: string) {
  const pipeline = await ensurePipeline(ctx, companyId);
  const stages = await listStages(ctx, pipeline.pipelineId);
  return new Map(stages.map((stage) => [stage.id, { id: stage.id, name: stage.name, kind: stageKind(stage.kind), position: stage.position }]));
}

function parseKind(value: unknown): (typeof FIND_KINDS)[number] {
  if (value == null || value === "") return "any";
  if (value === "company" || value === "contact" || value === "any") return value;
  throw new CrmError("kind must be company, contact or any");
}

function parseLifecycle(value: unknown): Lifecycle | null {
  if (value == null || value === "") return null;
  if (typeof value === "string" && (LIFECYCLES as readonly string[]).includes(value)) return value as Lifecycle;
  throw new CrmError("lifecycle must be lead, prospect, customer or churned");
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value == null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1) throw new CrmError(`limit must be a whole number from 1 to ${max}`);
  return Math.min(n, max);
}

/** `company:<id>` / `contact:<id>`, or `{ kind, id }`. */
export function parseClientRef(value: unknown, label = "client"): { kind: ClientKind; id: string } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as { kind?: unknown; id?: unknown };
    if ((v.kind === "company" || v.kind === "contact") && typeof v.id === "string" && v.id.trim()) return { kind: v.kind, id: v.id.trim() };
  }
  if (typeof value === "string") {
    const match = /^(company|contact):([A-Za-z0-9_-]{1,128})$/.exec(value.trim());
    if (match) return { kind: match[1] as ClientKind, id: match[2]! };
  }
  throw new CrmError(`${label} must be company:<id> or contact:<id> (find it with find-records)`);
}

type Match = "name" | "email" | "domain" | "phone" | "tag" | "all";

export interface FoundRecord {
  ref: string;
  kind: ClientKind;
  id: string;
  name: string;
  lifecycle: string;
  domain?: string | null;
  billingEmail?: string | null;
  address?: string | null;
  vatNumber?: string | null;
  registrationNumber?: string | null;
  email?: string | null;
  phone?: string | null;
  tags: string[];
  companies?: string[];
  match: Match[];
  link: string;
}

function matchCompany(row: AccountDraft, q: string): Match[] {
  if (!q) return ["all"];
  const out: Match[] = [];
  const lower = q.toLowerCase();
  if (row.name.toLowerCase().includes(lower)) out.push("name");
  const domain = row.domain ? bareDomain(row.domain) : "";
  if (domain) {
    const asDomain = bareDomain(lower.includes("@") ? lower.split("@").pop()! : lower);
    if (asDomain && (domain === asDomain || (asDomain.length >= 4 && domain.includes(asDomain)))) out.push(lower.includes("@") ? "email" : "domain");
  }
  if (row.tags.some((tag) => tag.toLowerCase() === lower)) out.push("tag");
  return out;
}

function matchContact(row: ContactDraft, q: string): Match[] {
  if (!q) return ["all"];
  const out: Match[] = [];
  const lower = q.toLowerCase();
  if (row.name.toLowerCase().includes(lower)) out.push("name");
  if (row.emails.some((email) => email.toLowerCase().includes(lower))) out.push("email");
  else if (!lower.includes("@") && lower.includes(".") && row.emails.some((email) => bareDomain(email.split("@").pop() ?? "") === bareDomain(lower))) out.push("domain");
  const qDigits = digits(q);
  if (qDigits.length >= 6 && row.phones.some((phone) => {
    const p = digits(phone);
    // +27 82 123 4567 and 082 123 4567 are the same number.
    return p.includes(qDigits) || (qDigits.startsWith("0") && p.endsWith(qDigits.slice(1)));
  })) out.push("phone");
  if (row.tags.some((tag) => tag.toLowerCase() === lower)) out.push("tag");
  return out;
}

/** Exact name matches first, then names that start with the query, then the rest by name. */
function rank(name: string, q: string): number {
  const n = name.toLowerCase();
  const l = q.toLowerCase();
  if (!l) return 2;
  if (n === l) return 0;
  if (n.startsWith(l)) return 1;
  return 2;
}

export async function findRecords(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const q = typeof params.query === "string" ? params.query.trim() : "";
  const kind = parseKind(params.kind);
  const lifecycle = parseLifecycle(params.lifecycle);
  const limit = parseLimit(params.limit, 10, FIND_MAX);
  if (!q && !lifecycle) throw new CrmError("Give a query (name, email, domain, phone or tag) or a lifecycle");
  const [records, prefix] = await Promise.all([visible(ctx, viewer), companyPrefix(ctx, viewer.companyId)]);
  const accountName = new Map(records.accounts.map((row) => [row.id, row.name]));
  const found: Array<FoundRecord & { score: number }> = [];
  if (kind !== "contact") {
    for (const row of records.accounts) {
      if (lifecycle && row.lifecycle !== lifecycle) continue;
      const match = matchCompany(row, q);
      if (match.length === 0) continue;
      found.push({
        ref: refOf("company", row.id), kind: "company", id: row.id, name: row.name, lifecycle: row.lifecycle, domain: row.domain,
        ...Object.fromEntries(BILLING_KEYS.filter((key) => row[key]).map((key) => [key, row[key]])),
        tags: row.tags, match, link: crmLink(prefix, "company", row.id), score: rank(row.name, q),
      });
    }
  }
  if (kind !== "company") {
    for (const row of records.contacts) {
      if (lifecycle && row.lifecycle !== lifecycle) continue;
      const match = matchContact(row, q);
      if (match.length === 0) continue;
      const companies = records.links.filter((link) => link.contactId === row.id).map((link) => accountName.get(link.accountId)).filter((name): name is string => Boolean(name));
      found.push({
        ref: refOf("contact", row.id), kind: "contact", id: row.id, name: row.name, lifecycle: row.lifecycle,
        email: row.emails[0] ?? null, phone: row.phones[0] ?? null, tags: row.tags, companies, match,
        link: crmLink(prefix, "contact", row.id), score: rank(row.name, q) - (match.includes("email") || match.includes("phone") ? 0.5 : 0),
      });
    }
  }
  found.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  const results = found.slice(0, limit).map(({ score: _score, ...rest }) => rest);
  return {
    query: q || null,
    total: found.length,
    results,
    ...(found.length > limit ? { more: `${found.length - limit} more: narrow the query or raise limit (max ${FIND_MAX}).` } : {}),
    ...(found.length === 0 ? { next: "Nothing matched. Try another spelling, the email domain or a phone number before you create a record." } : {}),
  };
}

function dealSummary(deal: DealDraft, stages: Map<string, { name: string; kind: string }>) {
  const stage = stages.get(deal.stageId);
  return {
    id: deal.id,
    title: deal.title,
    amountMinor: deal.amountMinor,
    currency: deal.currency,
    stage: stage?.name ?? deal.stageId,
    stageId: deal.stageId,
    status: stage?.kind ?? "open",
    client: deal.accountId ? refOf("company", deal.accountId) : deal.contactId ? refOf("contact", deal.contactId) : null,
    contact: deal.contactId ? refOf("contact", deal.contactId) : null,
  };
}

async function recentActivity(ctx: PluginContext, kind: ClientKind, id: string, limit = 10) {
  const rows = await listActivities(ctx, kind, id, limit);
  return rows.map((row) => ({ at: row.createdAt, kind: row.kind, text: clip(row.body), ...(row.issueId ? { issueId: row.issueId } : {}) }));
}

function profileOut(record: ClientProfileRecord | null) {
  const profile: ClientProfile = record ? pickProfile(record) : { ...EMPTY_PROFILE };
  return { ...profile, missing: missingProfileFields(profile), missingBrand: missingBrandFields(profile), missingProposal: missingProposalFields(profile) };
}

export function pickProfile(record: ClientProfile): ClientProfile {
  return {
    brandVoice: record.brandVoice ?? null,
    audience: record.audience ?? null,
    services: record.services ?? [],
    servicesOther: record.servicesOther ?? [],
    website: record.website ?? null,
    bookingLink: record.bookingLink ?? null,
    bannedWords: record.bannedWords ?? [],
    toneNotes: record.toneNotes ?? null,
    logoKey: record.logoKey ?? null,
    primaryColor: record.primaryColor ?? null,
    secondaryColor: record.secondaryColor ?? null,
    accentColor: record.accentColor ?? null,
    fonts: record.fonts ?? [],
    toneExamples: record.toneExamples ?? [],
    scopeTemplateRef: record.scopeTemplateRef ?? null,
    termsRef: record.termsRef ?? null,
  };
}

function fieldFilled(profile: ClientProfile, field: ProfileField): boolean {
  // Services the vocabulary does not know are kept as text: something was entered, so it is not missing.
  if (field === "services") return profile.services.length > 0 || (profile.servicesOther?.length ?? 0) > 0;
  const value = profile[field];
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

/** The core profile fields still empty (the original seven). The brand kit and proposal fields have their own lists. */
export function missingProfileFields(profile: ClientProfile): ProfileField[] {
  return CORE_PROFILE_FIELDS.filter((field) => !fieldFilled(profile, field));
}

/** What a brand kit needs to be usable: the logo, the main colour, the fonts and examples of the tone. */
export function missingBrandFields(profile: ClientProfile): ProfileField[] {
  return (["logoKey", "primaryColor", "fonts", "toneExamples"] as const).filter((field) => !fieldFilled(profile, field));
}

export function missingProposalFields(profile: ClientProfile): ProfileField[] {
  return PROPOSAL_FIELDS.filter((field) => !fieldFilled(profile, field));
}

export async function getCompany(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const id = clientIdParam(params, "companyRecordId", "company");
  const [records, prefix, stages] = await Promise.all([visible(ctx, viewer), companyPrefix(ctx, viewer.companyId), stageMap(ctx, viewer.companyId)]);
  const account = records.accounts.find((row) => row.id === id);
  if (!account) throw new CrmError("Company was not found or is not visible to you (find it with find-records)");
  const peopleLinks = records.links.filter((link) => link.accountId === account.id);
  const contactById = new Map(records.contacts.map((row) => [row.id, row]));
  const people = peopleLinks.flatMap((link) => {
    const row = contactById.get(link.contactId);
    return row ? [{ ref: refOf("contact", row.id), name: row.name, role: link.roleLabel, email: row.emails[0] ?? null, phone: row.phones[0] ?? null, lifecycle: row.lifecycle, emailStatus: row.emailStatus ?? "ok" }] : [];
  });
  const peopleIds = new Set(peopleLinks.map((link) => link.contactId));
  const deals = records.deals.filter((deal) => deal.accountId === account.id || (deal.accountId == null && deal.contactId != null && peopleIds.has(deal.contactId)));
  const [activities, profile, clientLeads] = await Promise.all([
    recentActivity(ctx, "company", account.id),
    getClientProfile(ctx, viewer.companyId, "company", account.id),
    listClientLeads(ctx, viewer.companyId, "company", account.id, 5).catch(() => []),
  ]);
  const open = deals.filter((deal) => stages.get(deal.stageId)?.kind !== "won" && stages.get(deal.stageId)?.kind !== "lost");
  const won = deals.filter((deal) => stages.get(deal.stageId)?.kind === "won");
  return {
    ref: refOf("company", account.id),
    id: account.id,
    name: account.name,
    domain: account.domain,
    billingEmail: account.billingEmail,
    phone: account.phone,
    address: account.address,
    vatNumber: account.vatNumber,
    registrationNumber: account.registrationNumber,
    lifecycle: account.lifecycle,
    currency: account.currency,
    tags: account.tags,
    ...(Object.keys(account.custom).length ? { custom: account.custom } : {}),
    ...(account.humanOwned.length ? { humanOwned: account.humanOwned } : {}),
    ...(isCanaryAccount(account) ? { canary: true, canaryRules: CANARY_RULES } : {}),
    profile: profileOut(profile),
    people,
    openDeals: open.map((deal) => dealSummary(deal, stages)),
    wonDeals: won.length,
    activities,
    leadsFromTheirChannels: clientLeads.map((lead) => ({ at: lead.capturedAt, source: lead.platform ?? lead.source, from: lead.name ?? lead.handle ?? lead.email, text: clip(lead.message, 160) })),
    workspaceLinks: workspaceLinks(prefix, "company", account.id),
  };
}

export async function getContact(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const id = clientIdParam(params, "contactId", "contact");
  const [records, prefix, stages] = await Promise.all([visible(ctx, viewer), companyPrefix(ctx, viewer.companyId), stageMap(ctx, viewer.companyId)]);
  const contact = records.contacts.find((row) => row.id === id);
  if (!contact) throw new CrmError("Contact was not found or is not visible to you (find it with find-records)");
  const accountById = new Map(records.accounts.map((row) => [row.id, row]));
  const companies = records.links.filter((link) => link.contactId === contact.id).flatMap((link) => {
    const row = accountById.get(link.accountId);
    return row ? [{ ref: refOf("company", row.id), name: row.name, role: link.roleLabel, lifecycle: row.lifecycle }] : [];
  });
  const deals = records.deals.filter((deal) => deal.contactId === contact.id);
  const [activities, profile, running, sequences] = await Promise.all([
    recentActivity(ctx, "contact", contact.id),
    getClientProfile(ctx, viewer.companyId, "contact", contact.id),
    runningEnrollmentsForContact(ctx, viewer.companyId, contact.id).catch(() => []),
    listSequences(ctx, viewer.companyId).catch(() => []),
  ]);
  const sequenceName = new Map(sequences.map((row) => [row.id, row.name]));
  // What the person agreed to (a form's marketing tick box), one line each: who may email them, for what, and when.
  const consent = contact.emails[0] ? await consentSummary(ctx, viewer.companyId, contact.emails[0]).catch(() => []) : [];
  return {
    ref: refOf("contact", contact.id),
    id: contact.id,
    name: contact.name,
    emails: contact.emails,
    phones: contact.phones,
    lifecycle: contact.lifecycle,
    tags: contact.tags,
    emailStatus: contact.emailStatus ?? "ok",
    nextAction: contact.nextActionKind ? { kind: contact.nextActionKind, dueAt: contact.nextActionDueAt } : null,
    ...(contact.leadScore ? { leadScore: { fit: contact.leadScore.fit, intent: contact.leadScore.intent, urgency: contact.leadScore.urgency } } : {}),
    ...(Object.keys(contact.custom).length ? { custom: contact.custom } : {}),
    ...(contact.humanOwned.length ? { humanOwned: contact.humanOwned } : {}),
    ...(isCanaryContact(contact) ? { canary: true, canaryRules: CANARY_RULES } : {}),
    ...(consent.length ? { consent } : {}),
    companies,
    // A contact with no company is a client in their own right (a sole trader).
    profile: companies.length === 0 || profile ? profileOut(profile) : null,
    openDeals: deals.filter((deal) => stages.get(deal.stageId)?.kind === "open" || !stages.get(deal.stageId)).map((deal) => dealSummary(deal, stages)),
    sequences: running.map((row) => ({ enrollmentId: row.id, sequenceId: row.sequenceId, name: sequenceName.get(row.sequenceId) ?? row.sequenceId, step: row.stepPosition, nextDueAt: row.nextDueAt })),
    activities,
    workspaceLinks: workspaceLinks(prefix, "contact", contact.id),
  };
}

function clientIdParam(params: Record<string, unknown>, key: string, kind: ClientKind): string {
  const raw = params[key];
  if (typeof raw === "string" && raw.trim()) {
    const value = raw.trim();
    if (value.startsWith(`${kind}:`)) return value.slice(kind.length + 1);
    if (/^(company|contact):/.test(value)) throw new CrmError(`${key} must be a ${kind} (got ${value})`);
    return value;
  }
  throw new CrmError(`${key} is required`);
}

export async function listDealsTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const status = params.status == null || params.status === "" ? null : String(params.status);
  if (status && !(DEAL_STATUSES as readonly string[]).includes(status)) throw new CrmError("status must be open, won or lost");
  const client = params.client == null || params.client === "" ? null : parseClientRef(params.client);
  const limit = parseLimit(params.limit, 25, 50);
  const [records, stages] = await Promise.all([visible(ctx, viewer), stageMap(ctx, viewer.companyId)]);
  const stageQuery = typeof params.stage === "string" && params.stage.trim() ? params.stage.trim().toLowerCase() : null;
  const stageIds = stageQuery ? new Set([...stages.values()].filter((stage) => stage.id === params.stage || stage.name.toLowerCase() === stageQuery).map((stage) => stage.id)) : null;
  if (stageIds && stageIds.size === 0) throw new CrmError(`No stage called ${params.stage}. See list-stages.`);
  let companyPeople: Set<string> | null = null;
  if (client?.kind === "company") companyPeople = new Set(records.links.filter((link) => link.accountId === client.id).map((link) => link.contactId));
  const rows = records.deals.filter((deal) => {
    const kind = stages.get(deal.stageId)?.kind ?? "open";
    if (status && kind !== status) return false;
    if (stageIds && !stageIds.has(deal.stageId)) return false;
    if (client?.kind === "company") return deal.accountId === client.id || (deal.accountId == null && deal.contactId != null && companyPeople!.has(deal.contactId));
    if (client?.kind === "contact") return deal.contactId === client.id;
    return true;
  });
  return { total: rows.length, deals: rows.slice(0, limit).map((deal) => dealSummary(deal, stages)) };
}

export async function listStagesTool(ctx: PluginContext, viewer: Viewer) {
  const [stages, records] = await Promise.all([stageMap(ctx, viewer.companyId), visible(ctx, viewer)]);
  return {
    stages: [...stages.values()]
      .sort((a, b) => a.position - b.position)
      .map((stage) => ({ id: stage.id, name: stage.name, kind: stage.kind, deals: records.deals.filter((deal) => deal.stageId === stage.id).length })),
    note: "Move a deal with move-deal. Won sets the client to customer and tells Billing and the Cockpit; won or lost stops the contact's sequences.",
  };
}

export async function listSequencesTool(ctx: PluginContext, viewer: Viewer) {
  const rows = await listSequences(ctx, viewer.companyId);
  const counts = await ctx.db.query<{ sequence_id: string; running: unknown }>(
    `SELECT sequence_id, count(*)::text AS running
       FROM ${table(ctx, "enrollments")}
      WHERE company_id = $1 AND status = 'running'
      GROUP BY sequence_id`,
    [viewer.companyId],
  ).catch(() => [] as Array<{ sequence_id: string; running: unknown }>);
  const running = new Map(counts.map((row) => [row.sequence_id, Number(row.running) || 0]));
  const sequences = [];
  for (const row of rows) {
    const steps = await listSteps(ctx, row.id);
    const delivery = sequenceDelivery(row);
    sequences.push({
      id: row.id,
      name: row.name,
      delivery,
      completionMode: row.completion_mode === "sent" ? "sent" : "manual",
      ...(delivery === "email" ? { emailApproved: sequenceEmailApproved(row) } : {}),
      steps: steps.map((step) => ({ position: step.position, delayMinutes: step.delayMinutes, title: step.title })),
      running: running.get(row.id) ?? 0,
    });
  }
  return { sequences, ...(sequences.length === 0 ? { next: "No sequences yet: create one with create-sequence." } : {}) };
}

// ---------------------------------------------------------------------------
// Client profile
// ---------------------------------------------------------------------------

const TEXT_MAX = 1500;
const LIST_MAX = 30;
const ITEM_MAX = 120;

function textField(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new CrmError(`${field} must be text`);
  const text = value.trim();
  if (text.length > TEXT_MAX) throw new CrmError(`${field} is too long (${TEXT_MAX} characters at most)`);
  return text || null;
}

function listField(value: unknown, field: string): string[] {
  if (value == null) return [];
  const items = typeof value === "string" ? value.split(/[,;\n]/) : Array.isArray(value) ? value : null;
  if (!items || items.some((item) => typeof item !== "string")) throw new CrmError(`${field} must be a list of text`);
  const clean = [...new Set((items as string[]).map((item) => item.trim()).filter(Boolean))];
  if (clean.length > LIST_MAX) throw new CrmError(`${field} has too many items (${LIST_MAX} at most)`);
  if (clean.some((item) => item.length > ITEM_MAX)) throw new CrmError(`Each ${field} item is ${ITEM_MAX} characters at most`);
  return clean;
}

function urlField(value: unknown, field: string): string | null {
  const text = textField(value, field);
  if (!text) return null;
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname.includes(".")) throw new Error("no host");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new CrmError(`${field} must be a web address, e.g. https://example.co.za`);
  }
}

/** `#RGB` or `#RRGGBB` (the `#` is optional), saved as `#RRGGBB` in capitals. */
export function colorField(value: unknown, field: string): string | null {
  const text = textField(value, field);
  if (!text) return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (!match) throw new CrmError(`${field} must be a hex colour such as #1A73E8`);
  const hex = match[1]!.length === 3 ? match[1]!.split("").map((digit) => digit + digit).join("") : match[1]!;
  return `#${hex.toUpperCase()}`;
}

/**
 * The logo is an R2 object key inside this company's folder, as the module that
 * stored it names it (for example `social/<company id>/logo.png`): the CRM keeps the key only.
 */
export function logoKeyField(value: unknown, companyId: string | undefined): string | null {
  const text = textField(value, "logoKey");
  if (!text) return null;
  const shaped = /^[a-z0-9][a-z0-9-]{0,30}\/[A-Za-z0-9-]{1,64}\/[A-Za-z0-9._\/-]{1,200}$/.test(text) && !text.includes("..") && !text.includes("//");
  if (!shaped || (companyId && text.split("/")[1] !== companyId)) {
    throw new CrmError(`logoKey must be an R2 object key inside this company's folder, such as social/${companyId ?? "<company id>"}/logo.png`);
  }
  return text;
}

/** A reference to a document: a Billing or docs id, a repo path or a link. No spaces, no control characters. */
export function refField(value: unknown, field: string): string | null {
  const text = textField(value, field);
  if (!text) return null;
  if (text.length > 300 || !/^[A-Za-z0-9:/._#?&=%@+~-]+$/.test(text)) throw new CrmError(`${field} must be a document id, path or link (no spaces), 300 characters at most`);
  return text;
}

const FONT_MAX = 6;
const TONE_EXAMPLES_MAX = 8;
const TONE_EXAMPLE_CHARS = 400;

/** Font family names, as a font picker writes them (`Inter`, `Playfair Display`). */
function fontsField(value: unknown): string[] {
  const names = listField(value, "fonts");
  if (names.length > FONT_MAX) throw new CrmError(`fonts has too many items (${FONT_MAX} at most)`);
  const bad = names.find((name) => !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(name));
  if (bad) throw new CrmError(`Not a font name: ${bad}`);
  return names;
}

/** Short pieces written in the client's voice, so an agent can match the tone. Each is kept whole (commas inside are fine). */
function toneExamplesField(value: unknown): string[] {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\n+/) : null;
  if (!items || items.some((item) => typeof item !== "string")) throw new CrmError("toneExamples must be a list of text");
  const clean = (items as string[]).map((item) => item.trim()).filter(Boolean);
  if (clean.length > TONE_EXAMPLES_MAX) throw new CrmError(`toneExamples has too many items (${TONE_EXAMPLES_MAX} at most)`);
  if (clean.some((item) => item.length > TONE_EXAMPLE_CHARS)) throw new CrmError(`Each tone example is ${TONE_EXAMPLE_CHARS} characters at most`);
  return clean;
}

/**
 * Parses the fields present in `params` (absent = unchanged, null or "" = clear).
 * `services` stays as sent here; `normalizePatchServices` maps it to the vocabulary.
 * `companyId` lets `logoKey` be checked against the company's own R2 folder.
 */
export function profilePatch(params: Record<string, unknown>, companyId?: string): Partial<ClientProfile> {
  const patch: Partial<ClientProfile> = {};
  if ("brandVoice" in params) patch.brandVoice = textField(params.brandVoice, "brandVoice");
  if ("audience" in params) patch.audience = textField(params.audience, "audience");
  if ("services" in params) patch.services = listField(params.services, "services");
  if ("website" in params) patch.website = urlField(params.website, "website");
  if ("bookingLink" in params) patch.bookingLink = urlField(params.bookingLink, "bookingLink");
  if ("bannedWords" in params) patch.bannedWords = listField(params.bannedWords, "bannedWords");
  if ("toneNotes" in params) patch.toneNotes = textField(params.toneNotes, "toneNotes");
  if ("logoKey" in params) patch.logoKey = logoKeyField(params.logoKey, companyId);
  if ("primaryColor" in params) patch.primaryColor = colorField(params.primaryColor, "primaryColor");
  if ("secondaryColor" in params) patch.secondaryColor = colorField(params.secondaryColor, "secondaryColor");
  if ("accentColor" in params) patch.accentColor = colorField(params.accentColor, "accentColor");
  if ("fonts" in params) patch.fonts = fontsField(params.fonts);
  if ("toneExamples" in params) patch.toneExamples = toneExamplesField(params.toneExamples);
  if ("scopeTemplateRef" in params) patch.scopeTemplateRef = refField(params.scopeTemplateRef, "scopeTemplateRef");
  if ("termsRef" in params) patch.termsRef = refField(params.termsRef, "termsRef");
  return patch;
}

/** The vocabulary form of a patch's `services`: keys in `services`, anything else as text in `servicesOther`. */
export function normalizePatchServices(patch: Partial<ClientProfile>): Partial<ClientProfile> {
  if (!patch.services) return patch;
  const { services, other } = normalizeServices(patch.services);
  return { ...patch, services, servicesOther: other };
}

function isEmpty(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

/**
 * Applies a profile patch. A person's write marks the fields human-owned; an
 * agent may fill an empty human-owned field but never replace one.
 */
export function applyProfilePatch(current: ClientProfileRecord | null, patch: Partial<ClientProfile>, source: "agent" | "human"): { profile: ClientProfile; humanOwned: ProfileField[]; refused: ProfileField[]; changed: ProfileField[] } {
  const profile: ClientProfile = current ? pickProfile(current) : { ...EMPTY_PROFILE };
  const owned = new Set<ProfileField>(current?.humanOwned ?? []);
  const refused: ProfileField[] = [];
  const changed: ProfileField[] = [];
  for (const field of PROFILE_FIELDS) {
    if (!(field in patch)) continue;
    // A service list and the text that maps to no service travel together.
    const services = field === "services";
    const next = services ? { services: patch.services ?? [], other: patch.servicesOther ?? profile.servicesOther } : patch[field];
    const now = services ? { services: profile.services, other: profile.servicesOther } : profile[field];
    if (source === "agent" && owned.has(field) && (services ? !isEmpty(profile.services) || !isEmpty(profile.servicesOther) : !isEmpty(profile[field]))) {
      if (JSON.stringify(next) !== JSON.stringify(now)) refused.push(field);
      continue;
    }
    if (JSON.stringify(next) === JSON.stringify(now)) continue;
    if (services) {
      profile.services = patch.services ?? [];
      profile.servicesOther = patch.servicesOther ?? profile.servicesOther;
    } else {
      (profile as unknown as Record<string, unknown>)[field] = next;
    }
    changed.push(field);
    if (source === "human") {
      if (isEmpty(next) || (services && isEmpty(profile.services) && isEmpty(profile.servicesOther))) owned.delete(field);
      else owned.add(field);
    }
  }
  return { profile, humanOwned: PROFILE_FIELDS.filter((field) => owned.has(field)), refused, changed };
}

/** The client must be visible to the viewer. Returns its name. */
export async function requireClient(ctx: PluginContext, viewer: Viewer, client: { kind: ClientKind; id: string }): Promise<string> {
  const records = await visible(ctx, viewer);
  const row = client.kind === "company" ? records.accounts.find((a) => a.id === client.id) : records.contacts.find((c) => c.id === client.id);
  if (!row) throw new CrmError(`${client.kind === "company" ? "Company" : "Contact"} was not found or is not visible to you (find it with find-records)`);
  return row.name;
}

export async function getClientProfileTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const record = await getClientProfile(ctx, viewer.companyId, client.kind, client.id);
  const out = profileOut(record);
  return {
    client: refOf(client.kind, client.id),
    name,
    profile: out,
    humanOwned: record?.humanOwned ?? [],
    updatedAt: record?.updatedAt ?? null,
    ...(isCanaryId(client.id) ? { canary: true, canaryRules: CANARY_RULES } : {}),
    ...(out.missing.length ? { next: `Missing: ${out.missing.join(", ")}. Fill them from the proposal, discovery notes and their website with update-client-profile.` } : {}),
    ...(out.missingBrand.length ? { brandKitNext: `Brand kit still missing: ${out.missingBrand.join(", ")} (update-client-profile). The logo is an R2 key of an image already stored for this company.` } : {}),
  };
}

/**
 * The profile fields a person locks (only people may change them), from the
 * page's lock toggles. Agents never send this; for them it is ignored.
 */
export function profileOwnership(value: unknown): ProfileField[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new CrmError("humanOwned must be a list of profile fields");
  const unknown = (value as string[]).filter((item) => !(PROFILE_FIELDS as readonly string[]).includes(item));
  if (unknown.length > 0) throw new CrmError(`Not profile fields: ${unknown.join(", ")}`);
  return PROFILE_FIELDS.filter((field) => (value as string[]).includes(field));
}

export async function updateClientProfile(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>, source: "agent" | "human") {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const patch = normalizePatchServices(profilePatch(params, viewer.companyId));
  const ownership = source === "human" && params.humanOwned !== undefined ? profileOwnership(params.humanOwned) : null;
  if (Object.keys(patch).length === 0 && !ownership) throw new CrmError("Send at least one profile field to change");
  const current = await getClientProfile(ctx, viewer.companyId, client.kind, client.id);
  const servicesBefore = current?.services ?? [];
  const result = applyProfilePatch(current, patch, source);
  // A person's lock toggles set the list outright.
  if (ownership) result.humanOwned = ownership;
  // A row written before the vocabulary is saved in its mapped form by any save.
  const legacy = Boolean(current && !current.servicesNormalizedAt);
  if (result.changed.length > 0 || legacy || (source === "human" && JSON.stringify(result.humanOwned) !== JSON.stringify(current?.humanOwned ?? []))) {
    await saveClientProfile(ctx, {
      companyId: viewer.companyId,
      clientKind: client.kind,
      clientRef: client.id,
      profile: result.profile,
      humanOwned: result.humanOwned,
      updatedBy: viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null,
    });
  }
  const servicesDiff = diffServices(servicesBefore, result.profile.services);
  // The services changed: tell the other modules, and start what was added (a customer's new service opens its onboarding step).
  const serviceSteps = result.changed.includes("services") || (legacy && patch.services !== undefined)
    ? await onServicesChanged(ctx, { companyId: viewer.companyId, client, name, services: result.profile.services, diff: servicesDiff }).catch((error) => {
      ctx.logger.info("CRM service hand-off deferred", { client: refOf(client.kind, client.id), error: error instanceof Error ? error.message : String(error) });
      return null;
    })
    : null;
  const unmapped = patch.services ? result.profile.servicesOther : [];
  return {
    client: refOf(client.kind, client.id),
    name,
    profile: { ...result.profile, missing: missingProfileFields(result.profile), missingBrand: missingBrandFields(result.profile), missingProposal: missingProposalFields(result.profile) },
    changed: result.changed,
    refused: result.refused,
    humanOwned: result.humanOwned,
    ...(unmapped.length ? { unmappedServices: unmapped, servicesNote: `These are not in the services list, so they are kept as text only: ${unmapped.join(", ")}. The services are: ${SERVICE_KEYS.join(", ")}.` } : {}),
    ...(serviceSteps && (serviceSteps.opened.length || serviceSteps.covered.length) ? { serviceSteps } : {}),
  };
}
