/**
 * Privacy in the CRM (audit Q10-13, POPIA): why a person may be emailed, what we
 * hold about them, and erasing them.
 *
 * - Consent and lawful basis: `record-consent` writes a record with the basis,
 *   source, wording and time for a person (forms write theirs themselves, see
 *   consent.ts). A withdrawal also marks the address opted out and tells the
 *   other modules. Consent the other modules record arrives as `consent.recorded`.
 * - Export: `export-person-data` collects everything the CRM holds about one
 *   person (and says which other modules to ask for the rest).
 * - Erasure is irreversible, so it never runs on an agent's word. `request-erasure`
 *   opens an approval for a person with exactly what will go; when a person marks it
 *   done the CRM erases its own data and starts the cross-plugin request (kit
 *   `startErasure`: the Mailbox, Campaigns, Social, Billing and Accounting each erase
 *   and answer, and are asked again every hour until they have). Records the law
 *   obliges us to keep are reported as retained, with the reason, not deleted. When
 *   everyone has answered the personal data is removed from the approval too.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  consentSubjectKey,
  ERASURE_PARTICIPANTS,
  eraseSummary,
  isModuleEnabled,
  PIB_PLUGINS,
  reannounceErasures,
  registerConsentReceiver,
  registerEraseResultWatch,
  senderKeyOf,
  staleErasuresCheck,
  startErasure,
  type ConsentPurpose,
  type ConsentRecorded,
  type ContactEraseRequested,
  type ErasureReason,
  type ErasureScope,
  type HealthCheck,
  type LawfulBasis,
} from "@partnersinbiz/pib-plugin-kit";
import {
  approvalForSubject,
  deleteCareDataOfClient,
  getApproval,
  listActions,
  listCases,
  listFeedback,
  type ApprovalRecord,
} from "./care-store.js";
import { recordConsent } from "./consent.js";
import { contactsByEmail, getAccount, getContact, listDeals, listSequences, sequenceDelivery, enrollmentsForSequence, asRecord, table } from "./db.js";
import { CrmError, type ContactDraft, type Viewer } from "./domain.js";
import { deleteGrowthDataOfClient, eraseSignDocsOfPerson, signDocsOfEmails } from "./growth-erase.js";
import { emitSuppressed, setEmailStatus } from "./handoffs.js";
import { consentsOfSubject, deleteLeadDataOfClient, eraseFormData, getConsent, putConsent } from "./lead-store.js";
import { requireClient } from "./lookup.js";
import { PLUGIN_ID } from "./namespace.js";
import { requestApproval } from "./outbound.js";
import { deleteSitesOfClient } from "./sites.js";
import { deleteClientLeads, deleteClientProfile, deleteServiceSteps } from "./store.js";
import { emitContactDeleted } from "./sync.js";

const DAY_MS = 86_400_000;
const ORIGIN = `plugin:${PLUGIN_ID}` as const;

/** Our window to answer a data subject's request: 30 days from the request (a target; POPIA sets no fixed number of days for erasure). */
export const ERASE_DUE_DAYS = 30;

const PURPOSES: readonly ConsentPurpose[] = ["marketing_email", "marketing_sms", "newsletter", "profiling", "service_messages"];
const BASES: readonly LawfulBasis[] = ["consent", "contract", "legitimate_interest", "legal_obligation"];
const SOURCES = ["manual", "import", "reply", "api"] as const;

function pick<T extends string>(values: readonly T[], value: unknown, fallback: T, label: string): T {
  if (value == null || value === "") return fallback;
  if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T;
  throw new CrmError(`${label} must be one of ${values.join(", ")}`);
}

function actorOf(viewer: Viewer): string {
  return viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : "system";
}

// ---------------------------------------------------------------------------
// Who a request is about
// ---------------------------------------------------------------------------

export interface Person {
  /** Every CRM contact that is this person (they may be in the CRM twice). */
  contacts: ContactDraft[];
  emails: string[];
  phones: string[];
}

/** Finds the person by contact id or email, in this company only. An address with no contact is still a person (other modules may hold them). */
export async function findPerson(ctx: PluginContext, companyId: string, params: { contactId?: unknown; email?: unknown }): Promise<Person> {
  const contacts: ContactDraft[] = [];
  const emails = new Set<string>();
  const wantedId = typeof params.contactId === "string" && params.contactId.trim() ? params.contactId.trim().replace(/^contact:/, "") : null;
  const wantedEmail = typeof params.email === "string" && params.email.includes("@") ? params.email.trim().toLowerCase() : null;
  if (!wantedId && !wantedEmail) throw new CrmError("Say who: contactId, or the person's email address");
  if (wantedId) {
    const contact = await getContact(ctx, wantedId);
    if (!contact || contact.companyId !== companyId) throw new CrmError("That contact was not found (find it with find-records)");
    contacts.push(contact);
  }
  if (wantedEmail) emails.add(wantedEmail);
  for (const contact of [...contacts]) for (const email of contact.emails) if (email.includes("@")) emails.add(email.trim().toLowerCase());
  for (const email of [...emails]) {
    for (const contact of await contactsByEmail(ctx, companyId, email)) {
      if (!contacts.some((known) => known.id === contact.id)) contacts.push(contact);
      for (const address of contact.emails) if (address.includes("@")) emails.add(address.trim().toLowerCase());
    }
  }
  return { contacts, emails: [...emails], phones: [...new Set(contacts.flatMap((contact) => contact.phones).filter(Boolean))] };
}

// ---------------------------------------------------------------------------
// Consent and lawful basis
// ---------------------------------------------------------------------------

/** `record-consent`: why this person may (or may no longer) be contacted, with the wording and where it came from. */
export async function recordConsentTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const person = await findPerson(ctx, viewer.companyId, params);
  const email = person.emails[0];
  if (!email) throw new CrmError("The person has no email address on file: send email as well as contactId");
  const purpose = pick(PURPOSES, params.purpose, "marketing_email", "purpose");
  const basis = pick(BASES, params.basis, "consent", "basis");
  const source = pick(SOURCES, params.source, "manual", "source");
  const granted = params.granted === false ? false : true;
  const wording = typeof params.wording === "string" ? params.wording.trim().slice(0, 1000) : "";
  if (granted && wording.length < 10) {
    throw new CrmError("Say what the person agreed to, or why there is another lawful basis (at least a sentence) in `wording`: what they wrote or saw, where and when. A basis without evidence is not recorded.");
  }
  if (granted && basis === "consent" && source === "api") throw new CrmError("Consent from a person is recorded as manual, reply or import, never api.");
  const expiresInDays = params.expiresInDays == null || params.expiresInDays === "" ? null : Number(params.expiresInDays);
  if (expiresInDays !== null && (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650)) throw new CrmError("expiresInDays must be a whole number from 1 to 3650");
  let client: { kind: "company" | "contact"; id: string } | null = null;
  if (typeof params.client === "string" && params.client.trim()) {
    const m = /^(company|contact):([A-Za-z0-9_-]{1,128})$/.exec(params.client.trim());
    if (!m) throw new CrmError("client must be company:<id> or contact:<id> (the client whose list this consent is for); leave it out for our own list");
    client = { kind: m[1] as "company" | "contact", id: m[2]! };
    await requireClient(ctx, viewer, client);
  }
  const outcome = await recordConsent(ctx, {
    companyId: viewer.companyId,
    client,
    email,
    contactId: person.contacts[0]?.id ?? null,
    purpose,
    basis,
    granted,
    source,
    wording: wording || null,
    url: typeof params.url === "string" && /^https?:\/\//.test(params.url) ? params.url.slice(0, 500) : null,
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * DAY_MS).toISOString() : null,
    recordedBy: actorOf(viewer),
  });
  if (!outcome) throw new CrmError("Could not record it: the person needs an email address.");
  // A withdrawal of marketing consent is an opt-out: stop the sequences and tell Campaigns and the Mailbox.
  let optedOut = 0;
  if (!granted && (purpose === "marketing_email" || purpose === "newsletter") && outcome.status === "recorded") {
    for (const contact of person.contacts) {
      await setEmailStatus(ctx, contact, "unsubscribed", { source: viewer.userId && !viewer.agentId ? "human" : "agent", note: "consent withdrawn" });
      optedOut += 1;
    }
    for (const address of person.emails) await emitSuppressed(ctx, viewer.companyId, { email: address, reason: "unsubscribed" }).catch(() => false);
  }
  return {
    recorded: outcome.status === "recorded",
    status: outcome.status,
    person: email,
    purpose,
    basis,
    granted,
    source,
    ...(optedOut ? { optedOut: `${optedOut} contact${optedOut === 1 ? "" : "s"} marked unsubscribed; sequences stopped; other modules told` } : {}),
    ...(outcome.status === "stale" ? { note: "A newer record for this person and purpose was already on file, so this older one was ignored." } : {}),
  };
}

/** Consent another module recorded (`consent.recorded`): upsert it, newest wins. Never announced again (the sender already did). */
export async function onConsentFromModule(ctx: PluginContext, companyId: string, consent: ConsentRecorded): Promise<void> {
  const subjectKey = consentSubjectKey(consent.subject);
  if (!subjectKey) return;
  const senderKey = senderKeyOf(consent.subject.clientKind && consent.subject.clientRef ? { clientKind: consent.subject.clientKind, clientRef: consent.subject.clientRef } : null);
  const current = await getConsent(ctx, companyId, senderKey, subjectKey, consent.purpose);
  if (current && Date.parse(current.recordedAt) > Date.parse(consent.recordedAt)) return;
  await putConsent(ctx, {
    companyId,
    senderKey,
    subjectKey,
    email: consent.subject.email?.trim().toLowerCase() ?? null,
    contactId: consent.subject.contactId ?? null,
    purpose: consent.purpose,
    basis: consent.basis,
    granted: consent.granted,
    source: consent.source,
    wording: consent.evidence?.wording ?? null,
    formId: consent.evidence?.formId ?? null,
    url: consent.evidence?.url ?? null,
    policyVersion: consent.evidence?.policyVersion ?? null,
    ipHash: null,
    recordedAt: consent.recordedAt,
    expiresAt: consent.expiresAt ?? null,
    recordedBy: consent.recordedBy ?? null,
  });
}

/** Contacts in a running email sequence with no consent or other lawful basis on file (and not customers). Informational: nothing is blocked. */
export async function consentGaps(ctx: PluginContext, companyId: string, limit = 200): Promise<Array<{ contactId: string; name: string }>> {
  const gaps: Array<{ contactId: string; name: string }> = [];
  for (const sequence of await listSequences(ctx, companyId)) {
    if (sequenceDelivery(sequence) !== "email") continue;
    for (const enrollment of await enrollmentsForSequence(ctx, companyId, sequence.id)) {
      if (enrollment.status !== "running" || gaps.some((gap) => gap.contactId === enrollment.contactId)) continue;
      const contact = await getContact(ctx, enrollment.contactId);
      if (!contact || contact.companyId !== companyId || contact.lifecycle === "customer") continue;
      const email = contact.emails.find((item) => item.includes("@"));
      const key = email ? consentSubjectKey({ email }) : null;
      const records = key ? await consentsOfSubject(ctx, companyId, key) : [];
      const covered = records.some((row) => row.granted && (row.purpose === "marketing_email" || row.purpose === "newsletter") && (!row.expiresAt || Date.parse(row.expiresAt) > Date.now()));
      if (!covered) gaps.push({ contactId: contact.id, name: contact.name });
      if (gaps.length >= limit) return gaps;
    }
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// Collecting what we hold about a person (export, and what an erasure removes)
// ---------------------------------------------------------------------------

export interface PersonData {
  person: Person;
  links: Array<{ accountId: string; company: string | null; role: string }>;
  activities: Array<{ id: string; kind: string; body: string; createdAt: string | null; issueId: string | null }>;
  facts: Array<{ id: string; field: string; value: unknown; createdAt: string | null }>;
  enrollments: Array<{ id: string; sequenceId: string; status: string }>;
  consent: Array<{ sender: string; purpose: string; basis: string; granted: boolean; source: string; recordedAt: string; wording: string | null }>;
  clientLeads: Array<{ key: string; name: string | null; email: string | null; phone: string | null; message: string; source: string; capturedAt: string | null; issueId: string | null }>;
  deals: Array<{ id: string; title: string; amountMinor: number; currency: string }>;
  cases: Array<{ id: string; title: string; status: string }>;
  clientActions: Array<{ id: string; title: string; status: string }>;
  feedback: Array<{ id: string; kind: string; status: string; score: number | null }>;
  approvals: ApprovalRecord[];
  handoffIds: string[];
  outboxKeys: string[];
  heldLeadIds: string[];
  decisionIds: string[];
  issueIds: string[];
  /** Rows the CRM keeps for them as a client (a sole trader is a client under their own contact id), for the approval a person reads. */
  clientRecords: number;
  /** Documents sent to their address to sign, and how many of them are signed (those stay as the agreement's evidence). */
  documents: { total: number; signed: number };
}

/** Every table whose rows are keyed to a client by (client_kind, client_ref). */
const CLIENT_KEYED_TABLES = [
  "client_signals", "client_reports", "client_actions", "support_cases", "client_feedback", "client_health", "client_sensitivity", "care_approvals",
  "client_profiles", "client_projects", "client_leads", "service_onboarding", "lead_sources", "client_sites", "sign_documents", "event_keys", "esign_clients",
] as const;

/** How many rows the CRM keeps for one contact as a client: what `eraseClientRecordsOfContact` will remove. Read only. */
async function clientRecordCount(ctx: PluginContext, companyId: string, contactId: string): Promise<number> {
  let found = 0;
  for (const name of CLIENT_KEYED_TABLES) {
    found += (await ctx.db.query(`SELECT 1 AS n FROM ${table(ctx, name)} WHERE company_id = $1 AND client_kind = 'contact' AND client_ref = $2 LIMIT 500`, [companyId, contactId])).length;
  }
  return found;
}

const ids = (list: string[]) => JSON.stringify(list);
const stamp = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);

function mentions(payload: unknown, person: Person): boolean {
  const text = JSON.stringify(payload ?? "").toLowerCase();
  return person.emails.some((email) => text.includes(email));
}

export async function collectPersonData(ctx: PluginContext, companyId: string, person: Person): Promise<PersonData> {
  const contactIds = person.contacts.map((contact) => contact.id);
  const data: PersonData = { person, links: [], activities: [], facts: [], enrollments: [], consent: [], clientLeads: [], deals: [], cases: [], clientActions: [], feedback: [], approvals: [], handoffIds: [], outboxKeys: [], heldLeadIds: [], decisionIds: [], issueIds: [], clientRecords: 0, documents: { total: 0, signed: 0 } };
  for (const contactId of contactIds) data.clientRecords += await clientRecordCount(ctx, companyId, contactId);
  data.documents = await signDocsOfEmails(ctx, companyId, person.emails);
  if (contactIds.length) {
    const links = await ctx.db.query<{ account_id: string; role_label: string }>(`SELECT account_id, role_label FROM ${table(ctx, "contact_companies")} WHERE company_id = $1 AND contact_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))) LIMIT 100`, [companyId, ids(contactIds)]);
    for (const link of links) data.links.push({ accountId: link.account_id, company: (await getAccount(ctx, link.account_id))?.name ?? null, role: link.role_label });
    const activities = await ctx.db.query<{ id: string; kind: string; body: string; created_at: unknown; issue_id: string | null }>(`SELECT id, kind, body, created_at, issue_id FROM ${table(ctx, "activities")} WHERE company_id = $1 AND record_type = 'contact' AND record_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))) LIMIT 2000`, [companyId, ids(contactIds)]);
    data.activities = activities.map((row) => ({ id: row.id, kind: row.kind, body: row.body, createdAt: stamp(row.created_at), issueId: row.issue_id ?? null }));
    const facts = await ctx.db.query<{ id: string; field_key: string; value: unknown; created_at: unknown }>(`SELECT id, field_key, value, created_at FROM ${table(ctx, "facts")} WHERE company_id = $1 AND record_type = 'contact' AND record_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))) LIMIT 2000`, [companyId, ids(contactIds)]);
    data.facts = facts.map((row) => ({ id: row.id, field: row.field_key, value: row.value, createdAt: stamp(row.created_at) }));
    const enrollments = await ctx.db.query<{ id: string; sequence_id: string; status: string }>(`SELECT id, sequence_id, status FROM ${table(ctx, "enrollments")} WHERE company_id = $1 AND contact_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))) LIMIT 500`, [companyId, ids(contactIds)]);
    data.enrollments = enrollments.map((row) => ({ id: row.id, sequenceId: row.sequence_id, status: row.status }));
    const decisions = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "decisions")} WHERE company_id = $1 AND subject_kind = 'contact' AND subject_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))) LIMIT 1000`, [companyId, ids(contactIds)]);
    data.decisionIds = decisions.map((row) => row.id);
    data.deals = (await listDeals(ctx, companyId)).filter((deal) => deal.companyId === companyId && deal.contactId != null && contactIds.includes(deal.contactId)).map((deal) => ({ id: deal.id, title: deal.title, amountMinor: deal.amountMinor, currency: deal.currency }));
  }
  const seen = new Set<string>();
  for (const email of person.emails) {
    const key = consentSubjectKey({ email });
    if (key) for (const row of await consentsOfSubject(ctx, companyId, key)) if (!seen.has(row.id)) {
      seen.add(row.id);
      data.consent.push({ sender: row.senderKey, purpose: row.purpose, basis: row.basis, granted: row.granted, source: row.source, recordedAt: row.recordedAt, wording: row.wording });
    }
    const leads = await ctx.db.query<{ key: string; name: string | null; email: string | null; phone: string | null; message: string; source: string; captured_at: unknown; issue_id: string | null }>(
      `SELECT key, name, email, phone, message, source, captured_at, issue_id FROM ${table(ctx, "client_leads")} WHERE company_id = $1 AND email = $2 LIMIT 500`, [companyId, email]);
    for (const lead of leads) data.clientLeads.push({ key: lead.key, name: lead.name, email: lead.email, phone: lead.phone, message: lead.message, source: lead.source, capturedAt: stamp(lead.captured_at), issueId: lead.issue_id ?? null });
  }
  data.cases = (await listCases(ctx, companyId, null, 500)).filter((c) => c.contactId != null && contactIds.includes(c.contactId)).map((c) => ({ id: c.id, title: c.title, status: c.status }));
  data.clientActions = (await listActions(ctx, companyId, null, 500)).filter((a) => (a.contactId != null && contactIds.includes(a.contactId)) || (a.toEmail != null && person.emails.includes(a.toEmail.toLowerCase()))).map((a) => ({ id: a.id, title: a.title, status: a.status }));
  data.feedback = (await listFeedback(ctx, companyId, null, 500)).filter((f) => (f.contactId != null && contactIds.includes(f.contactId)) || (f.toEmail != null && person.emails.includes(f.toEmail.toLowerCase()))).map((f) => ({ id: f.id, kind: f.kind, status: f.status, score: f.score }));
  const approvalRows = await ctx.db.query<{ id: string }>(`SELECT id FROM ${table(ctx, "care_approvals")} WHERE company_id = $1 AND kind <> 'erasure' LIMIT 1000`, [companyId]);
  for (const row of approvalRows) {
    const approval = await getApproval(ctx, companyId, row.id);
    if (approval && mentions(approval.payload, person)) data.approvals.push(approval);
  }
  const handoffs = await ctx.db.query<{ id: string; payload: unknown }>(`SELECT id, payload FROM ${table(ctx, "handoffs")} WHERE company_id = $1 ORDER BY created_at DESC LIMIT 2000`, [companyId]);
  data.handoffIds = handoffs.filter((row) => mentions(row.payload, person)).map((row) => row.id);
  const outbox = await ctx.db.query<{ key: string; payload: unknown }>(`SELECT key, payload FROM ${table(ctx, "outbox")} WHERE company_id = $1 LIMIT 2000`, [companyId]);
  data.outboxKeys = outbox.filter((row) => mentions(row.payload, person)).map((row) => row.key);
  const held = await ctx.db.query<{ id: string; payload: unknown }>(`SELECT id, payload FROM ${table(ctx, "held_leads")} WHERE company_id = $1 LIMIT 500`, [companyId]);
  data.heldLeadIds = held.filter((row) => mentions(row.payload, person)).map((row) => row.id);
  data.issueIds = [...new Set([...data.activities.map((a) => a.issueId), ...data.clientLeads.map((l) => l.issueId), ...data.approvals.map((a) => a.issueId)].filter((id): id is string => Boolean(id)))];
  return data;
}

/** What the CRM holds about a person, as counts (for the approval a person reads). */
export function personDataCounts(data: PersonData): Record<string, number> {
  return {
    contacts: data.person.contacts.length,
    activities: data.activities.length,
    notes_on_fields: data.facts.length,
    sequence_enrollments: data.enrollments.length,
    consent_records: data.consent.length,
    client_leads: data.clientLeads.length,
    deals_linked: data.deals.length,
    support_cases: data.cases.length,
    client_requests: data.clientActions.length,
    feedback: data.feedback.length,
    emails_drafted_or_queued: data.approvals.length + data.outboxKeys.length,
    records_kept_for_them_as_a_client: data.clientRecords,
    issues_mentioning_them: data.issueIds.length,
    ...(data.documents.total > 0 ? { documents_sent_to_sign: data.documents.total } : {}),
  };
}

const OTHER_MODULES: Array<{ plugin: string; what: string; how: string }> = [
  { plugin: PIB_PLUGINS.mailbox, what: "their emails with us (threads, messages, attachments)", how: "partnersinbiz.mailbox search-mail and list-threads with their address" },
  { plugin: PIB_PLUGINS.campaigns, what: "campaign sends, opens, clicks and replies", how: "partnersinbiz.campaigns list-campaigns and campaign-stats, filtered to their address" },
  { plugin: PIB_PLUGINS.social, what: "inbox messages and comments they sent a client's social account", how: "partnersinbiz.social list-inbox, search for their handle" },
  { plugin: PIB_PLUGINS.billing, what: "quotes, invoices and payments in their name (kept for tax law)", how: "partnersinbiz.billing list-open-invoices, invoice-detail" },
  { plugin: PIB_PLUGINS.accounting, what: "ledger entries that name them (kept for tax law)", how: "the Bookkeeper" },
];

/** `export-person-data`: everything the CRM holds about one person, for a data subject access request. */
export async function exportPersonDataTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const person = await findPerson(ctx, viewer.companyId, params);
  if (person.contacts.length === 0 && person.emails.length === 0) throw new CrmError("Nothing found for that person");
  const data = await collectPersonData(ctx, viewer.companyId, person);
  const out = {
    person: {
      emails: person.emails,
      phones: person.phones,
      contacts: person.contacts.map((contact) => ({ id: contact.id, name: contact.name, lifecycle: contact.lifecycle, tags: contact.tags, emailStatus: contact.emailStatus ?? "ok", custom: contact.custom })),
    },
    companies: data.links,
    consent: data.consent,
    activities: data.activities.slice(0, 200),
    fieldHistory: data.facts.slice(0, 200),
    sequences: data.enrollments,
    websiteEnquiries: data.clientLeads.slice(0, 100),
    deals: data.deals,
    supportCases: data.cases,
    requestsToThem: data.clientActions,
    feedback: data.feedback,
  };
  const text = JSON.stringify(out);
  return {
    counts: personDataCounts(data),
    data: text.length > 90_000 ? { ...out, activities: data.activities.slice(0, 40), fieldHistory: data.facts.slice(0, 40), websiteEnquiries: data.clientLeads.slice(0, 20), truncated: true } : out,
    notInTheCrm: OTHER_MODULES.map((m) => ({ module: m.plugin.replace(/^partnersinbiz\./, ""), holds: m.what, ask: m.how })),
    next: [
      "Check the requester is the person (they write from the address on file, or you confirm another way) before you share anything.",
      "To give them a copy, draft a Mailbox email to the address on file for a person to approve. Never send it to a different address.",
      "The other modules hold their own data about them: collect it from the tools above, or ask the owner to run the erasure/export in those modules.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Erasing
// ---------------------------------------------------------------------------

export interface ErasureOutcome {
  counts: Record<string, number>;
  retained: Array<{ what: string; why: string }>;
}

const ISSUE_ERASED = "Personal data was erased from this issue on request (POPIA).";

async function redactIssues(ctx: PluginContext, companyId: string, issueIds: string[]): Promise<number> {
  let redacted = 0;
  for (const issueId of issueIds) {
    try {
      const issue = await ctx.issues.get(issueId, companyId);
      // Only what this plugin opened: another module's issue is that module's to redact.
      if (!issue || issue.originKind !== ORIGIN) continue;
      await ctx.issues.update(issueId, { title: "Erased on request", description: ISSUE_ERASED }, companyId);
      redacted += 1;
    } catch (error) {
      ctx.logger.info("CRM issue could not be redacted", { issueId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return redacted;
}

async function removeRows(ctx: PluginContext, name: string, column: string, companyId: string, values: string[]): Promise<number> {
  let count = 0;
  for (const value of values) {
    const res = await ctx.db.execute(`DELETE FROM ${table(ctx, name)} WHERE company_id = $1 AND ${column} = $2`, [companyId, value]);
    count += res?.rowCount ?? 0;
  }
  return count;
}

/**
 * A sole trader is a client under their own contact id, so what the CRM keeps for them as a client names them too: reports, health
 * scores, signals, sensitivity, their client profile, websites, lead forms and the enquiries those took, onboarding steps and the
 * client's project links. They go with the person (a company contact is not a client: this finds nothing for them). Idempotent.
 */
async function eraseClientRecordsOfContact(ctx: PluginContext, companyId: string, contactId: string): Promise<number> {
  let removed = await deleteCareDataOfClient(ctx, companyId, { kind: "contact", id: contactId });
  removed += await deleteSitesOfClient(ctx, companyId, "contact", contactId);
  removed += (await deleteLeadDataOfClient(ctx, companyId, "contact", contactId)).sources;
  await deleteClientLeads(ctx, companyId, "contact", contactId);
  await deleteServiceSteps(ctx, companyId, "contact", contactId);
  await deleteClientProfile(ctx, companyId, "contact", contactId);
  removed += (await ctx.db.execute(`DELETE FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND client_kind = 'contact' AND client_ref = $2`, [companyId, contactId]))?.rowCount ?? 0;
  // Documents they were sent to sign, the site counters and the cost records kept for them as a client (a signed agreement stays: see growth-erase.ts).
  removed += (await deleteGrowthDataOfClient(ctx, companyId, { kind: "contact", id: contactId })).removed;
  return removed;
}

/**
 * Erases (or, for marketing_only, stops marketing to) one person in the CRM. Idempotent: a second run finds nothing. What the CRM
 * deletes: the contact and its links, notes, field history, sequences, consent records, website enquiries, scores, drafted and
 * queued emails, requests, feedback, and the hand-off copies; for a sole trader also everything kept for them as a client (reports, health,
 * websites, forms, profile); support cases are kept without the person; deals are kept unlinked; issues the CRM opened about them are blanked.
 */
export async function eraseSubjectInCrm(ctx: PluginContext, companyId: string, person: Person, scope: ErasureScope): Promise<ErasureOutcome> {
  const data = await collectPersonData(ctx, companyId, person);
  const contactIds = person.contacts.map((contact) => contact.id);
  const counts: Record<string, number> = {};
  const retained: Array<{ what: string; why: string }> = [];
  const add = (kind: string, n: number) => {
    if (n > 0) counts[kind] = (counts[kind] ?? 0) + n;
  };

  // Marketing: always. Sequences, consent, lead scores and the queued or drafted emails to them.
  add("sequence_enrollments", await removeRows(ctx, "enrollments", "id", companyId, data.enrollments.map((row) => row.id)));
  add("queued_emails", await removeRows(ctx, "outbox", "key", companyId, data.outboxKeys));
  let consent = 0;
  for (const email of person.emails) consent += (await eraseFormData(ctx, companyId, email, contactIds)).consentRecords;
  add("consent_records", consent);
  add("lead_scores", await removeRows(ctx, "decisions", "id", companyId, data.decisionIds));

  if (scope === "marketing_only") {
    // Keep the record, but never market to it: opted out everywhere, and the other modules are told.
    for (const contact of person.contacts) {
      if ((contact.emailStatus ?? "ok") !== "unsubscribed") await ctx.db.execute(`UPDATE ${table(ctx, "contacts")} SET email_status = 'unsubscribed', lead_fit = NULL, lead_intent = NULL, lead_urgency = NULL, lead_confidence = NULL, lead_scored_at = NULL, updated_at = now() WHERE id = $1`, [contact.id]);
    }
    let told = 0;
    for (const email of person.emails) if (await emitSuppressed(ctx, companyId, { email, reason: "unsubscribed" }).catch(() => false)) told += 1;
    add("addresses_opted_out", told);
    return { counts, retained };
  }

  add("website_enquiries", await removeRows(ctx, "client_leads", "key", companyId, data.clientLeads.map((lead) => lead.key)));
  for (const contactId of contactIds) {
    await ctx.db.execute(`UPDATE ${table(ctx, "lead_captures")} SET contact_id = NULL WHERE company_id = $1 AND contact_id = $2`, [companyId, contactId]);
  }
  add("held_leads", await removeRows(ctx, "held_leads", "id", companyId, data.heldLeadIds));
  add("activities", await removeRows(ctx, "activities", "id", companyId, data.activities.map((row) => row.id)));
  add("field_history", await removeRows(ctx, "facts", "id", companyId, data.facts.map((row) => row.id)));
  add("hand_off_copies", await removeRows(ctx, "handoffs", "id", companyId, data.handoffIds));
  add("client_requests", await removeRows(ctx, "client_actions", "id", companyId, data.clientActions.map((row) => row.id)));
  add("feedback", await removeRows(ctx, "client_feedback", "id", companyId, data.feedback.map((row) => row.id)));
  add("drafted_emails", await removeRows(ctx, "care_approvals", "id", companyId, data.approvals.map((approval) => approval.id)));
  for (const c of data.cases) {
    await ctx.db.execute(`UPDATE ${table(ctx, "support_cases")} SET contact_id = NULL, title = 'Support case (person erased)', summary = '', updated_at = now() WHERE company_id = $1 AND id = $2`, [companyId, c.id]);
  }
  add("support_cases_anonymised", data.cases.length);
  let unlinked = 0;
  for (const deal of data.deals) {
    unlinked += (await ctx.db.execute(`UPDATE ${table(ctx, "deals")} SET contact_id = NULL, updated_at = now() WHERE company_id = $1 AND id = $2`, [companyId, deal.id]))?.rowCount ?? 0;
  }
  add("deals_unlinked", unlinked);
  if (unlinked) retained.push({ what: `${unlinked} deal${unlinked === 1 ? "" : "s"} (title and value)`, why: "A deal is a business record of an agreement or quote; the person is unlinked from it." });
  let clientRecords = 0;
  for (const contactId of contactIds) clientRecords += await eraseClientRecordsOfContact(ctx, companyId, contactId);
  add("client_records", clientRecords);
  const documents = await eraseSignDocsOfPerson(ctx, companyId, person.emails);
  add("documents_sent_to_sign", documents.removed);
  if (documents.keptSigned) retained.push({ what: `${documents.keptSigned} signed document${documents.keptSigned === 1 ? "" : "s"} (the text, the signature and the audit trail)`, why: "A signed agreement is a business record and the evidence of what was agreed. It is kept; only a lawyer's advice should change that." });
  add("company_links", await removeRows(ctx, "contact_companies", "contact_id", companyId, contactIds));
  add("shares", await removeRows(ctx, "record_grants", "record_id", companyId, contactIds));
  add("issues_blanked", await redactIssues(ctx, companyId, data.issueIds));
  if (data.issueIds.length) retained.push({ what: "comments on issues the CRM opened about them", why: "Paperclip does not let a plugin edit issue comments. A person removes them in Paperclip if they hold personal data." });
  // The contacts last, so everything above could still find them.
  add("contacts", await removeRows(ctx, "contacts", "id", companyId, contactIds));
  for (const contactId of contactIds) await emitContactDeleted(ctx, companyId, contactId).catch(() => undefined);
  return { counts, retained };
}

const REASONS: readonly ErasureReason[] = ["data_subject_request", "retention_expired", "client_offboarding", "withdrawn_consent"];

interface ErasurePayload {
  requestId: string;
  subject: { email: string | null; phone: string | null; contactId: string | null };
  scope: ErasureScope;
  reason: ErasureReason;
  dueBy: string;
  evidence: string;
  requestedBy: string;
  counts: Record<string, number>;
}

/** `request-erasure`: opens the approval a person decides. Nothing is erased until they do. */
export async function requestErasureTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const person = await findPerson(ctx, viewer.companyId, params);
  if (person.emails.length === 0 && person.contacts.length === 0) throw new CrmError("Nothing found for that person");
  const scope: ErasureScope = params.scope === "marketing_only" ? "marketing_only" : "all";
  const reason = pick(REASONS, params.reason, "data_subject_request", "reason");
  const evidence = typeof params.evidence === "string" ? params.evidence.trim().slice(0, 1000) : "";
  if (evidence.length < 15) throw new CrmError("Say how the request came and how you know it is the person (at least a sentence) in `evidence`: for example the email they sent, its date, and that it came from the address on file.");
  if (params.identityChecked !== true) throw new CrmError("Check that the request is from the person themselves, then send identityChecked true. Erasure is irreversible.");
  const requestId = `er-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const data = await collectPersonData(ctx, viewer.companyId, person);
  const counts = personDataCounts(data);
  const subject = { email: person.emails[0] ?? null, phone: person.phones[0] ?? null, contactId: person.contacts[0]?.id ?? null };
  const dueBy = new Date(Date.now() + ERASE_DUE_DAYS * DAY_MS).toISOString();
  const payload: ErasurePayload = { requestId, subject, scope, reason, dueBy, evidence, requestedBy: actorOf(viewer), counts };
  const name = person.contacts[0]?.name ?? subject.email ?? "the person";
  const opened = await requestApproval(ctx, {
    companyId: viewer.companyId,
    kind: "erasure",
    client: null,
    subjectId: requestId,
    title: `Approve erasure: ${name}`,
    intro: [
      `${scope === "all" ? "Erase **everything** we hold about" : "Stop **all marketing** to"} **${name}** (${person.emails.join(", ") || "no email"}). Reason: ${reason.replace(/_/g, " ")}. Asked for by ${payload.requestedBy}.`,
      `**Evidence:** ${evidence}`,
      "",
      "**What the CRM holds and will remove:**",
      ...Object.entries(counts).filter(([, n]) => n > 0).map(([kind, n]) => `- ${kind.replace(/_/g, " ")}: ${n}`),
      "",
      scope === "all"
        ? "The Mailbox, Campaigns, Social, Billing and Accounting are then asked to erase their own data about this person. Records the law makes us keep (invoices, ledger entries) are kept and reported, not deleted. This cannot be undone."
        : "The contact stays but is marked unsubscribed everywhere, and its sequences, lead scores and consent records are removed.",
      `Our target is to answer within ${ERASE_DUE_DAYS} days (until ${dueBy.slice(0, 10)}).`,
    ],
    payload: { request: payload },
    checks: [],
    outward: false,
    actorUserId: viewer.userId,
    wakeReason: "An erasure request needs a person's decision",
  });
  return {
    requestId,
    approvalIssueId: opened.issueId,
    status: "awaiting_approval" as const,
    willRemove: counts,
    dueBy,
    next: "A person decides: done approves the erasure, cancelled refuses it. Do not erase anything yourself. Tell the person asking that you have started the request and when to expect an answer (our target is within 30 days).",
  };
}

export interface ErasureResult {
  counts: Record<string, number>;
  retained: Array<{ what: string; why: string }>;
  announcedTo: string[];
}

/** A person approved: erase in the CRM, then ask the other modules. Returns what was done. Throws when the CRM part fails (nothing is announced). */
export async function executeApprovedErasure(ctx: PluginContext, approval: ApprovalRecord, approvedByUserId: string): Promise<ErasureResult> {
  const request = asRecord(approval.payload.request) as unknown as ErasurePayload;
  const person = await findPerson(ctx, approval.companyId, { contactId: request.subject.contactId, email: request.subject.email }).catch(async () => {
    // The contact may already be gone (an earlier run, or a manual delete): erase by address alone.
    return { contacts: [], emails: request.subject.email ? [request.subject.email.toLowerCase()] : [], phones: request.subject.phone ? [request.subject.phone] : [] } as Person;
  });
  const outcome = await eraseSubjectInCrm(ctx, approval.companyId, person, request.scope);
  const message: ContactEraseRequested = {
    key: `erase:${request.requestId}`,
    requestId: request.requestId,
    subject: { email: request.subject.email, phone: request.subject.phone, contactId: request.subject.contactId },
    scope: request.scope,
    reason: request.reason,
    approvedByUserId,
    approvalIssueId: approval.issueId,
    requestedAt: approval.createdAt ?? new Date().toISOString(),
    dueBy: request.dueBy,
    source: PLUGIN_ID,
  };
  const participants: string[] = [];
  for (const plugin of ERASURE_PARTICIPANTS) {
    if (plugin === PLUGIN_ID) continue;
    if (await isModuleEnabled(ctx, approval.companyId, plugin).catch(() => false)) participants.push(plugin);
  }
  await startErasure(ctx, approval.companyId, message, participants);
  return { ...outcome, announcedTo: participants };
}

/** After the erasure: the personal data leaves the approval and its issue, so the log shows that it happened without keeping what it erased. */
export async function redactErasureApproval(ctx: PluginContext, approval: ApprovalRecord): Promise<void> {
  const request = asRecord(approval.payload.request);
  const redacted = { ...approval.payload, request: { requestId: request.requestId, scope: request.scope, reason: request.reason, dueBy: request.dueBy, counts: request.counts, subject: {}, evidence: "[removed]", requestedBy: request.requestedBy }, intro: ["Personal data removed after the erasure."], title: "Erasure request (completed)" };
  await ctx.db.execute(`UPDATE ${table(ctx, "care_approvals")} SET payload = $3::jsonb, updated_at = now() WHERE company_id = $1 AND id = $2`, [approval.companyId, approval.id, JSON.stringify(redacted)]);
  if (approval.issueId) await ctx.issues.update(approval.issueId, { title: "Erasure request (completed)", description: "The erasure was carried out. Who it was about is no longer kept here. The comments below say what was erased and what is kept." }, approval.companyId).catch(() => undefined);
}

/** Subscribes the CRM to what the other modules answer (`contact.erase.completed`) and to consent they record. Call once in setup. */
export function registerPrivacy(ctx: PluginContext): void {
  registerEraseResultWatch(ctx, async (companyId, result, ledger) => {
    const approval = await approvalForSubject(ctx, companyId, "erasure", result.requestId, 1);
    if (!approval?.issueId) return;
    const lines = [`${result.plugin.replace(/^partnersinbiz\./, "")} answered: ${result.status}${Object.entries(result.counts).filter(([, n]) => n > 0).length ? ` (${Object.entries(result.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}.`];
    if (result.retained.length) lines.push(`Kept by law: ${result.retained.map((r) => `${r.what} (${r.why})`).join("; ")}.`);
    if (result.error) lines.push(`Problem: ${result.error}`);
    await ctx.issues.createComment(approval.issueId, lines.join(" "), companyId).catch(() => undefined);
    if (ledger.done && ledger.entry) await ctx.issues.createComment(approval.issueId, `Every module has answered. ${eraseSummary(ledger.entry)}`, companyId).catch(() => undefined);
  }, ERASURE_PARTICIPANTS.filter((plugin) => plugin !== PLUGIN_ID));
  registerConsentReceiver(ctx, { plugin: PLUGIN_ID, onConsent: (companyId, consent) => onConsentFromModule(ctx, companyId, consent) });
}

/** Hourly: ask again every module that has not answered (events are at-most-once). */
export async function reannounceAll(ctx: PluginContext, companyId: string): Promise<number> {
  return reannounceErasures(ctx, companyId);
}

/** Cockpit: an approved erasure a module never answered, and people in email sequences with no basis on file. */
export async function privacyHealth(ctx: PluginContext, companyId: string): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  const stale = await staleErasuresCheck(ctx, companyId).catch(() => null);
  if (stale) checks.push(stale);
  const gaps = await consentGaps(ctx, companyId, 50).catch(() => []);
  checks.push(gaps.length
    ? {
      key: "privacy:consent-gaps",
      title: "Email without a recorded basis",
      status: "warn",
      detail: `${gaps.length}${gaps.length >= 50 ? "+" : ""} contact${gaps.length === 1 ? " is" : "s are"} in a running email sequence with no consent or lawful basis on file: ${gaps.slice(0, 3).map((gap) => gap.name).join(", ")}${gaps.length > 3 ? ", ..." : ""}.`,
      href: "/crm",
      fix: "Record why each may be emailed with record-consent (a reply, a signed form, an existing-customer relationship), or stop their sequence.",
    }
    : { key: "privacy:consent-gaps", title: "Email without a recorded basis", status: "ok", detail: "Everyone in a running email sequence has a basis on file, or is a customer." });
  return checks;
}
