/**
 * Support cases (audit Q1b-10, Q10-12): a case lifecycle on top of issues.
 *
 * The host's Cases feature has no plugin capability, so the CRM keeps its own:
 * a case belongs to a client, has a source (mail, lead, portal, manual, uptime),
 * a severity, and two SLA targets (first response and resolution) that run from
 * the moment it opens. The hourly care job flags a breach once (an issue for the
 * Account Manager, a red check in the Cockpit). A case that comes by mail does not
 * get a second work issue: the Mailbox's Reply-needed issue stays, and the case
 * wraps it (a done Reply-needed issue on the case's thread is the first response,
 * because the Mailbox only lets it close once the thread has a reply). A case from
 * another source opens an issue for the Account Manager in the client's project.
 *
 * Clocks are calendar hours (no business-hours model yet). A case waiting on the
 * client pauses the resolution clock: the time spent waiting is added back when it
 * leaves that status.
 *
 * Feedback: an NPS or CSAT request is an email to a person at the client, drafted
 * for approval (never sent by itself). A reply that starts with a score is recorded
 * by the plugin; a low score opens an issue for the Account Manager.
 */
import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { HealthCheck, MailReceived } from "@partnersinbiz/pib-plugin-kit";
import { clientContacts, clientInfo, clientProjectOf, logOnClient, pickRecipient, firstName } from "./care-clients.js";
import {
  CASE_SEVERITIES,
  CASE_SOURCES,
  CASE_STATUSES,
  caseBySourceKey,
  casesByThread,
  getCase,
  getFeedback,
  insertCase,
  insertFeedback,
  listCases,
  listCasesByStatus,
  listFeedback,
  saveCase,
  saveFeedback,
  type CaseSeverity,
  type CaseSource,
  type CaseStatus,
  type ClientKey,
  type FeedbackKind,
  type FeedbackRecord,
  type SupportCase,
} from "./care-store.js";
import { contactCompanyLinks, getContact } from "./db.js";
import { CrmError, type Viewer } from "./domain.js";
import { parseClientRef, requireClient, visibleClients } from "./lookup.js";
import { openIssueOnce } from "./mail.js";
import { originFor } from "./origins.js";
import { approvalLink, requestApproval, type MailApprovalHooks } from "./outbound.js";
import { brandName, companyPrefix, crmLink, refOf } from "./refs.js";
import { teamAssignee } from "./routing.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

/** Calendar hours from the moment a case opens. */
export const SLA_HOURS: Record<CaseSeverity, { firstResponse: number; resolution: number }> = {
  urgent: { firstResponse: 1, resolution: 8 },
  high: { firstResponse: 4, resolution: 24 },
  normal: { firstResponse: 8, resolution: 72 },
  low: { firstResponse: 24, resolution: 168 },
};

export function slaDueDates(severity: CaseSeverity, from: Date, overrides: { firstResponseHours?: number | null; resolutionHours?: number | null } = {}): { firstResponseDueAt: string; resolutionDueAt: string } {
  const base = SLA_HOURS[severity];
  const first = overrides.firstResponseHours ?? base.firstResponse;
  const resolution = overrides.resolutionHours ?? base.resolution;
  return { firstResponseDueAt: new Date(from.getTime() + first * HOUR_MS).toISOString(), resolutionDueAt: new Date(from.getTime() + resolution * HOUR_MS).toISOString() };
}

export type SlaState = "met" | "ok" | "at_risk" | "breached" | "paused";

export interface CaseSla {
  firstResponse: SlaState;
  resolution: SlaState;
}

const closedStatus = (status: CaseStatus) => status === "resolved" || status === "closed";

/** Where a case stands against its two targets. At risk means under a quarter of the window is left. */
export function caseSla(c: SupportCase, now: number): CaseSla {
  const created = Date.parse(c.createdAt ?? "") || now;
  const stateFor = (due: string, met: boolean, paused: boolean): SlaState => {
    if (met) return "met";
    if (paused) return "paused";
    const dueMs = Date.parse(due);
    if (now > dueMs) return "breached";
    return dueMs - now < (dueMs - created) * 0.25 ? "at_risk" : "ok";
  };
  const responded = Boolean(c.firstResponseAt) || closedStatus(c.status);
  return {
    firstResponse: stateFor(c.firstResponseDueAt, responded, false),
    resolution: stateFor(c.resolutionDueAt, closedStatus(c.status), c.status === "waiting_client"),
  };
}

function hoursOverride(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.25 || n > 24 * 60) throw new CrmError(`${label} must be between 0.25 and 1440 hours`);
  return n;
}

// ---------------------------------------------------------------------------
// Opening a case
// ---------------------------------------------------------------------------

function clamp(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

export interface NewCase {
  companyId: string;
  client: ClientKey;
  title: string;
  summary: string;
  source: CaseSource;
  severity: CaseSeverity;
  contactId: string | null;
  threadId: string | null;
  sourceKey: string | null;
  openedBy: string | null;
  firstResponseHours?: number | null;
  resolutionHours?: number | null;
  /** Mail cases wrap the Mailbox's Reply-needed issue and open no work issue of their own. */
  openIssue: boolean;
}

/** Creates a case (once per source key) and, unless it wraps a Reply-needed issue, the work issue for the Account Manager. */
export async function createCase(ctx: PluginContext, input: NewCase, now = new Date()): Promise<{ case: SupportCase; created: boolean; issueId: string | null }> {
  if (input.sourceKey) {
    const existing = await caseBySourceKey(ctx, input.companyId, input.sourceKey);
    if (existing) return { case: existing, created: false, issueId: existing.issueId };
  }
  const due = slaDueDates(input.severity, now, { firstResponseHours: input.firstResponseHours, resolutionHours: input.resolutionHours });
  const c: SupportCase = {
    id: randomUUID(),
    companyId: input.companyId,
    client: input.client,
    title: input.title,
    summary: input.summary,
    source: input.source,
    severity: input.severity,
    status: "new",
    contactId: input.contactId,
    threadId: input.threadId,
    sourceKey: input.sourceKey,
    replyIssueId: null,
    issueId: null,
    ...due,
    firstResponseAt: null,
    resolvedAt: null,
    firstBreachedAt: null,
    resolutionBreachedAt: null,
    escalatedAt: null,
    pausedAt: null,
    resolution: null,
    openedBy: input.openedBy,
    createdAt: now.toISOString(),
  };
  const inserted = await insertCase(ctx, c);
  if (!inserted) {
    const existing = input.sourceKey ? await caseBySourceKey(ctx, input.companyId, input.sourceKey) : null;
    return { case: existing ?? c, created: false, issueId: existing?.issueId ?? null };
  }
  let issueId: string | null = null;
  if (input.openIssue) {
    const info = await clientInfo(ctx, input.companyId, input.client);
    const prefix = await companyPrefix(ctx, input.companyId);
    issueId = await openIssueOnce(ctx, {
      companyId: input.companyId,
      originId: originFor.supportCase(c.id),
      title: `Support (${input.severity}): ${info?.name ?? "client"}: ${input.title}`.slice(0, 200),
      description: [
        `A support case for ${info?.name ?? "a client"}${info ? ` (${crmLink(prefix, input.client.kind, input.client.id)})` : ""}.`,
        "",
        `**Case:** \`${c.id}\` · severity ${input.severity} · source ${input.source}`,
        `**First response due:** ${c.firstResponseDueAt} · **Resolution due:** ${c.resolutionDueAt}`,
        "",
        input.summary || "(no summary)",
        "",
        "Work it (the **pib-crm-records** skill, Client care): answer the client from the Mailbox (a draft a person approves), fix what is wrong or hand it to the right teammate, and keep the case current with `update-support-case` (first response, waiting on the client, resolved with what you did).",
        "",
        "**Done when** the case is resolved or closed. Closing checks it.",
      ].join("\n"),
      assignee: await teamAssignee(ctx, input.companyId),
      wakeReason: "A client support case needs work",
      projectId: await clientProjectOf(ctx, input.companyId, input.client),
      priority: input.severity === "urgent" ? "critical" : input.severity === "high" ? "high" : "medium",
    });
    await saveCase(ctx, { ...c, issueId });
    c.issueId = issueId;
  }
  await logOnClient(ctx, input.companyId, input.client, "note", `Support case opened (${input.severity}): ${input.title}.`, `care:case:${c.id}:opened`, issueId);
  return { case: c, created: true, issueId };
}

/** The agent tool and page action: open a case. */
export async function openSupportCaseTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const title = clamp(params.title, 160);
  if (!title) throw new CrmError("title is required: what the client needs, in a few words");
  const severity = typeof params.severity === "string" && params.severity ? params.severity : "normal";
  if (!(CASE_SEVERITIES as readonly string[]).includes(severity)) throw new CrmError(`severity must be one of ${CASE_SEVERITIES.join(", ")}`);
  const source = typeof params.source === "string" && params.source ? params.source : "manual";
  if (!(CASE_SOURCES as readonly string[]).includes(source)) throw new CrmError(`source must be one of ${CASE_SOURCES.join(", ")}`);
  let contactId: string | null = null;
  if (typeof params.contactId === "string" && params.contactId.trim()) {
    const wanted = params.contactId.trim().replace(/^contact:/, "");
    if (!(await clientContacts(ctx, viewer.companyId, client)).some((contact) => contact.id === wanted)) throw new CrmError("That contact is not one of this client's people");
    contactId = wanted;
  }
  const threadId = clamp(params.threadId, 200);
  const messageId = clamp(params.messageId, 200);
  // A case for a Mailbox thread that already has one open is that case: say so instead of opening a second.
  if (threadId) {
    const open = (await casesByThread(ctx, viewer.companyId, threadId)).find((c) => !closedStatus(c.status));
    if (open) return { created: false, note: "This thread already has an open case.", ...caseOut(open, Date.now()) };
  }
  const result = await createCase(ctx, {
    companyId: viewer.companyId,
    client,
    title,
    summary: clamp(params.summary, 2000) ?? "",
    source: source as CaseSource,
    severity: severity as CaseSeverity,
    contactId,
    threadId,
    sourceKey: messageId ? `mail:${messageId}` : null,
    openedBy: viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null,
    firstResponseHours: hoursOverride(params.firstResponseHours, "firstResponseHours"),
    resolutionHours: hoursOverride(params.resolutionHours, "resolutionHours"),
    openIssue: source !== "mail",
  });
  const prefix = await companyPrefix(ctx, viewer.companyId);
  return {
    created: result.created,
    name,
    ...caseOut(result.case, Date.now()),
    issueId: result.issueId,
    clientPage: crmLink(prefix, client.kind, client.id),
    next: source === "mail"
      ? "The Mailbox's Reply-needed issue for the thread is the work; answer it there. Keep the case current with update-support-case."
      : "An issue was opened for the Account Manager. Keep the case current with update-support-case.",
  };
}

// ---------------------------------------------------------------------------
// Updating a case
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  new: ["open", "waiting_client", "resolved"],
  open: ["waiting_client", "resolved"],
  waiting_client: ["open", "resolved"],
  resolved: ["open", "closed"],
  closed: [],
};

/** Applies a status change to a case record: the clocks and timestamps that go with it. Pure. */
export function applyStatus(c: SupportCase, status: CaseStatus, now: Date, resolution: string | null): SupportCase {
  if (c.status === status) return c;
  if (!TRANSITIONS[c.status].includes(status)) throw new CrmError(`A ${c.status} case cannot go to ${status}. From ${c.status} it can go to: ${TRANSITIONS[c.status].join(", ") || "nothing (open a new case)"}.`);
  const next: SupportCase = { ...c, status };
  // Leaving waiting_client gives the time spent waiting back to the resolution target.
  if (c.status === "waiting_client" && c.pausedAt) {
    const waited = Math.max(0, now.getTime() - Date.parse(c.pausedAt));
    next.resolutionDueAt = new Date(Date.parse(c.resolutionDueAt) + waited).toISOString();
    next.pausedAt = null;
  }
  if (status === "waiting_client") next.pausedAt = now.toISOString();
  if (status === "resolved") {
    if (!resolution || resolution.trim().length < 10) throw new CrmError("Say what resolved it (at least a sentence) in `resolution`.");
    next.resolvedAt = now.toISOString();
    next.resolution = resolution.trim().slice(0, 1000);
    // A resolved case was answered, whatever route the answer took.
    next.firstResponseAt = c.firstResponseAt ?? now.toISOString();
    next.pausedAt = null;
  }
  if (status === "open" && c.status === "resolved") {
    next.resolvedAt = null;
    next.resolutionBreachedAt = null;
  }
  return next;
}

export async function updateSupportCaseTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const id = typeof params.caseId === "string" ? params.caseId.trim() : "";
  if (!id) throw new CrmError("caseId is required (list-support-cases shows them)");
  const found = await getCase(ctx, viewer.companyId, id);
  if (!found) throw new CrmError("That support case was not found");
  await requireClient(ctx, viewer, found.client);
  const now = new Date();
  let c = { ...found };
  if (typeof params.status === "string" && params.status) {
    if (!(CASE_STATUSES as readonly string[]).includes(params.status)) throw new CrmError(`status must be one of ${CASE_STATUSES.join(", ")}`);
    c = applyStatus(c, params.status as CaseStatus, now, clamp(params.resolution, 1000));
  }
  if (typeof params.severity === "string" && params.severity && params.severity !== c.severity) {
    if (!(CASE_SEVERITIES as readonly string[]).includes(params.severity)) throw new CrmError(`severity must be one of ${CASE_SEVERITIES.join(", ")}`);
    const next = params.severity as CaseSeverity;
    // The targets are the tighter of the old and the new from when the case opened: raising the severity tightens them,
    // lowering it never gives time back.
    const tight = slaDueDates(next, new Date(c.createdAt ?? now.toISOString()));
    c.firstResponseDueAt = new Date(Math.min(Date.parse(c.firstResponseDueAt), Date.parse(tight.firstResponseDueAt))).toISOString();
    c.resolutionDueAt = new Date(Math.min(Date.parse(c.resolutionDueAt), Date.parse(tight.resolutionDueAt))).toISOString();
    c.severity = next;
  }
  if (params.firstResponse === true && !c.firstResponseAt) {
    c.firstResponseAt = now.toISOString();
    if (c.status === "new") c.status = "open";
  }
  const summary = clamp(params.summary, 2000);
  if (summary) c.summary = summary;
  await saveCase(ctx, c);
  const note = clamp(params.note, 500);
  const changes = [found.status !== c.status ? `status ${found.status} to ${c.status}` : "", found.severity !== c.severity ? `severity ${found.severity} to ${c.severity}` : "", params.firstResponse === true && !found.firstResponseAt ? "first response recorded" : ""].filter(Boolean);
  if (changes.length || note) {
    await logOnClient(ctx, viewer.companyId, c.client, "note", `Support case "${c.title}": ${changes.join(", ") || "update"}${note ? `. ${note}` : ""}`, `care:case:${c.id}:u:${randomUUID()}`, c.issueId);
  }
  return caseOut(c, now.getTime());
}

export function caseOut(c: SupportCase, now: number) {
  const sla = caseSla(c, now);
  return {
    caseId: c.id,
    client: refOf(c.client.kind, c.client.id),
    title: c.title,
    severity: c.severity,
    status: c.status,
    source: c.source,
    openedAt: c.createdAt,
    firstResponseDueAt: c.firstResponseDueAt,
    resolutionDueAt: c.resolutionDueAt,
    firstResponseAt: c.firstResponseAt,
    resolvedAt: c.resolvedAt,
    sla,
    issueId: c.issueId ?? c.replyIssueId,
  };
}

export async function listSupportCasesTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = params.client == null || params.client === "" ? null : parseClientRef(params.client);
  if (client) await requireClient(ctx, viewer, client);
  const filter = typeof params.status === "string" && params.status ? params.status : "open";
  const now = Date.now();
  // With no client named, only the clients this viewer may see: the same rule the CRM's other lists follow.
  const seen = client ? null : await visibleClients(ctx, viewer);
  const all = (await listCases(ctx, viewer.companyId, client, 300)).filter((c) => !seen || seen.has(c.client.kind, c.client.id));
  const rows = all.filter((c) => {
    if (filter === "all") return true;
    if (filter === "open") return !closedStatus(c.status);
    if (filter === "breached") return !closedStatus(c.status) && (caseSla(c, now).firstResponse === "breached" || caseSla(c, now).resolution === "breached");
    return c.status === filter;
  });
  return { count: rows.length, cases: rows.slice(0, 50).map((c) => caseOut(c, now)) };
}

/** The workspace card: a client's cases, newest first. */
export async function caseViews(ctx: PluginContext, companyId: string, client: ClientKey) {
  const now = Date.now();
  return (await listCases(ctx, companyId, client, 30)).map((c) => caseOut(c, now));
}

// ---------------------------------------------------------------------------
// Mail triage: a support mail becomes a case
// ---------------------------------------------------------------------------

/** Mail that is a request from a client (the Mailbox sorted it as support), not a bulk or risky message. */
export function isSupportMail(mail: Pick<MailReceived, "triage">): boolean {
  const t = mail.triage;
  if (t?.category !== "support") return false;
  if ((t.phishing ?? 0) >= 0.9) return false;
  return t.needsReply == null || t.needsReply >= 0.3;
}

/**
 * The client a support mail is from: the Mailbox's client mapping when it made one, else the sender's contact. Only a customer has
 * support cases (a lead's question is the Inbound Qualifier's).
 */
async function clientOfMail(ctx: PluginContext, companyId: string, mail: MailReceived, contactMatch: (companyId: string, mail: MailReceived) => Promise<{ id: string } | null>): Promise<{ client: ClientKey; contactId: string | null } | null> {
  const mapped = mail.triage.clientKind && mail.triage.clientRef ? { kind: mail.triage.clientKind, id: mail.triage.clientRef } : null;
  const contact = await contactMatch(companyId, mail);
  const contactId = contact?.id ?? null;
  let client: ClientKey | null = mapped;
  if (!client && contactId) {
    const record = await getContact(ctx, contactId);
    const links = await contactCompanyLinks(ctx, contactId);
    client = links[0] ? { kind: "company", id: links[0].accountId } : record ? { kind: "contact", id: record.id } : null;
  }
  if (!client) return null;
  const info = await clientInfo(ctx, companyId, client);
  if (!info || info.lifecycle !== "customer") return null;
  return { client, contactId };
}

/** Called for each mail the Mailbox announces: opens (or reopens) the case for a support mail. Returns the case id, or null. */
export async function onSupportMail(
  ctx: PluginContext,
  companyId: string,
  mail: MailReceived,
  contactMatch: (companyId: string, mail: MailReceived) => Promise<{ id: string } | null>,
  now = new Date(),
): Promise<string | null> {
  if (!isSupportMail(mail)) return null;
  const found = await clientOfMail(ctx, companyId, mail, contactMatch);
  if (!found) return null;
  if (mail.threadId) {
    const existing = (await casesByThread(ctx, companyId, mail.threadId))[0];
    if (existing) {
      // A new message on a resolved case reopens it; an open case already covers it.
      if (existing.status === "resolved") {
        await saveCase(ctx, { ...existing, status: "open", resolvedAt: null, resolutionBreachedAt: null, ...slaDueDates(existing.severity, now), firstResponseAt: null, firstBreachedAt: null });
        await logOnClient(ctx, companyId, existing.client, "note", `Support case reopened by a new message: ${existing.title}.`, `care:case:${existing.id}:reopened:${mail.messageId}`);
      }
      return existing.id;
    }
  }
  const subject = mail.subject.trim() || "(no subject)";
  const urgency = mail.triage.urgency ?? 0;
  const result = await createCase(ctx, {
    companyId,
    client: found.client,
    title: subject.slice(0, 160),
    summary: mail.snippet.replace(/\s+/g, " ").trim().slice(0, 600),
    source: "mail",
    severity: urgency >= 2.5 ? "high" : "normal",
    contactId: found.contactId,
    threadId: mail.threadId || null,
    sourceKey: `mail:${mail.messageId}`,
    openedBy: "system:mail-triage",
    openIssue: false,
  }, now);
  return result.case.id;
}

/**
 * A Mailbox Reply-needed issue changed: link it to the case on its thread, and when it is done the thread has been answered (the
 * Mailbox only lets it close then), so the case's first response is recorded.
 */
export async function onReplyIssueUpdated(ctx: PluginContext, companyId: string, issue: { id: string; status: string; originId: string | null }, now = new Date()): Promise<boolean> {
  const origin = issue.originId ?? "";
  if (!origin.startsWith("mailbox:reply:")) return false;
  const rest = origin.slice("mailbox:reply:".length);
  const cut = rest.indexOf(":");
  const threadId = cut >= 0 ? rest.slice(cut + 1) : "";
  if (!threadId) return false;
  let touched = false;
  for (const c of await casesByThread(ctx, companyId, threadId)) {
    if (closedStatus(c.status)) continue;
    const next = { ...c, replyIssueId: c.replyIssueId ?? issue.id };
    if (issue.status === "done" && !c.firstResponseAt) {
      next.firstResponseAt = now.toISOString();
      if (next.status === "new") next.status = "open";
    }
    if (JSON.stringify(next) !== JSON.stringify(c)) {
      await saveCase(ctx, next);
      touched = true;
    }
  }
  return touched;
}

// ---------------------------------------------------------------------------
// The SLA job
// ---------------------------------------------------------------------------

export interface SlaRun {
  firstBreaches: number;
  resolutionBreaches: number;
}

/** Hourly (or more often): flag each breach once, with an issue for the Account Manager. */
export async function runSupportSla(ctx: PluginContext, companyId: string, now = new Date()): Promise<SlaRun> {
  const run: SlaRun = { firstBreaches: 0, resolutionBreaches: 0 };
  const open = [...(await listCasesByStatus(ctx, companyId, "new")), ...(await listCasesByStatus(ctx, companyId, "open")), ...(await listCasesByStatus(ctx, companyId, "waiting_client"))];
  for (const c of open) {
    const sla = caseSla(c, now.getTime());
    const flagged = { ...c };
    if (sla.firstResponse === "breached" && !c.firstBreachedAt) {
      flagged.firstBreachedAt = now.toISOString();
      await escalateBreach(ctx, c, "first");
      run.firstBreaches += 1;
    }
    if (sla.resolution === "breached" && !c.resolutionBreachedAt) {
      flagged.resolutionBreachedAt = now.toISOString();
      await escalateBreach(ctx, c, "resolution");
      run.resolutionBreaches += 1;
    }
    if (flagged.firstBreachedAt !== c.firstBreachedAt || flagged.resolutionBreachedAt !== c.resolutionBreachedAt) {
      flagged.escalatedAt = flagged.escalatedAt ?? now.toISOString();
      await saveCase(ctx, flagged);
    }
  }
  return run;
}

async function escalateBreach(ctx: PluginContext, c: SupportCase, which: "first" | "resolution"): Promise<void> {
  const info = await clientInfo(ctx, c.companyId, c.client);
  const prefix = await companyPrefix(ctx, c.companyId);
  await openIssueOnce(ctx, {
    companyId: c.companyId,
    originId: originFor.supportBreach(c.id, which),
    title: `SLA breached (${which === "first" ? "first response" : "resolution"}): ${info?.name ?? "client"}: ${c.title}`.slice(0, 200),
    description: [
      `The ${which === "first" ? `first-response target (${SLA_HOURS[c.severity].firstResponse} h for a ${c.severity} case)` : `resolution target (${SLA_HOURS[c.severity].resolution} h for a ${c.severity} case)`} ran out on a support case for ${info?.name ?? "a client"}.`,
      "",
      `**Case:** \`${c.id}\` · ${c.title}`,
      `**Opened:** ${c.createdAt} · **Due:** ${which === "first" ? c.firstResponseDueAt : c.resolutionDueAt}`,
      c.replyIssueId ? `**Reply-needed issue:** /issues/${c.replyIssueId}` : c.issueId ? `**Case issue:** /issues/${c.issueId}` : "",
      info ? `**Client:** ${crmLink(prefix, c.client.kind, c.client.id)}` : "",
      "",
      which === "first"
        ? "Answer the client now (a Mailbox draft a person approves), then record it with `update-support-case` (firstResponse true)."
        : "Resolve it, or tell the client when it will be done and set the case to waiting_client while they owe you something. Record it with `update-support-case`.",
      "",
      `**Done when** ${which === "first" ? "the first response is recorded or the case is resolved" : "the case is resolved or closed"}. Closing checks it.`,
    ].filter((line) => line !== "").join("\n"),
    assignee: await teamAssignee(ctx, c.companyId),
    wakeReason: "A support SLA ran out",
    projectId: await clientProjectOf(ctx, c.companyId, c.client),
    priority: "high",
  });
}

/** Done-check for an SLA breach issue. */
export async function breachResolved(ctx: PluginContext, companyId: string, originId: string): Promise<{ done: true } | { done: false; missing: string[] }> {
  const rest = originId.slice("crm:support-breach:".length);
  const cut = rest.lastIndexOf(":");
  const caseId = cut > 0 ? rest.slice(0, cut) : rest;
  const which = cut > 0 ? rest.slice(cut + 1) : "first";
  const c = await getCase(ctx, companyId, caseId);
  if (!c || closedStatus(c.status)) return { done: true };
  if (which === "first" && c.firstResponseAt) return { done: true };
  return { done: false, missing: [which === "first" ? `The case "${c.title}" (\`${c.id}\`) still has no first response recorded: answer the client, then \`update-support-case\` with firstResponse true.` : `The case "${c.title}" (\`${c.id}\`) is still ${c.status}: resolve it with \`update-support-case\` (status resolved and what you did), or set waiting_client when the client owes you something.`] };
}

/** Done-check for the work issue of a non-mail case: the case is resolved or closed. */
export async function caseIssueResolved(ctx: PluginContext, companyId: string, originId: string): Promise<{ done: true } | { done: false; missing: string[] }> {
  const c = await getCase(ctx, companyId, originId.slice("crm:support-case:".length));
  if (!c || closedStatus(c.status)) return { done: true };
  return { done: false, missing: [`The support case "${c.title}" (\`${c.id}\`) is still ${c.status}: finish the work and set it resolved with \`update-support-case\` (status resolved and what you did), or waiting_client when the client owes you something.`] };
}

/** Cockpit health: red while a target is breached on an open case, amber when one is about to be. */
export async function supportHealth(ctx: PluginContext, companyId: string, now = Date.now()): Promise<HealthCheck> {
  const open = [...(await listCasesByStatus(ctx, companyId, "new")), ...(await listCasesByStatus(ctx, companyId, "open")), ...(await listCasesByStatus(ctx, companyId, "waiting_client"))];
  const states = open.map((c) => ({ c, sla: caseSla(c, now) }));
  const breached = states.filter(({ sla }) => sla.firstResponse === "breached" || sla.resolution === "breached");
  const atRisk = states.filter(({ sla }) => sla.firstResponse === "at_risk" || sla.resolution === "at_risk");
  if (breached.length > 0) {
    return {
      key: "support:sla",
      title: "Support targets",
      status: "bad",
      detail: `${breached.length} support case${breached.length === 1 ? " has" : "s have"} run past a first-response or resolution target: ${breached.slice(0, 3).map(({ c }) => c.title).join("; ")}${breached.length > 3 ? "; ..." : ""}.`,
      href: "/crm",
      fix: "The Account Manager has an issue for each breach. Answer the client, then record it with update-support-case.",
      since: breached.map(({ c }) => c.firstBreachedAt ?? c.resolutionBreachedAt).filter((at): at is string => Boolean(at)).sort()[0] ?? null,
    };
  }
  if (atRisk.length > 0) {
    return { key: "support:sla", title: "Support targets", status: "warn", detail: `${atRisk.length} open case${atRisk.length === 1 ? " is" : "s are"} close to a target: ${atRisk.slice(0, 3).map(({ c }) => c.title).join("; ")}.`, href: "/crm", fix: "Answer or resolve them before the target runs out." };
  }
  return { key: "support:sla", title: "Support targets", status: "ok", detail: open.length ? `${open.length} open case${open.length === 1 ? "" : "s"}, all inside their targets.` : "No open support cases." };
}

// ---------------------------------------------------------------------------
// NPS and CSAT
// ---------------------------------------------------------------------------

/** A person is asked for NPS at most once in this many days. */
export const NPS_COOLDOWN_DAYS = 90;

export function feedbackEmail(kind: FeedbackKind, recipientName: string, caseTitle: string | null, brand: string | null = null): { subject: string; text: string } {
  const first = firstName(recipientName) || "there";
  if (kind === "nps") {
    return {
      subject: "One quick question",
      text: [
        `Hi ${first},`,
        "",
        `One quick question to help us do better for you: on a scale of 0 to 10, how likely are you to recommend ${brand ?? "us"} to a friend or colleague?`,
        "",
        "Just reply with a number. If you want to add a line about why, we read every one.",
        "",
        "Thank you,",
        brand ?? "The team",
      ].join("\n"),
    };
  }
  return {
    subject: caseTitle ? `How did we do? ${caseTitle}` : "How did we do?",
    text: [
      `Hi ${first},`,
      "",
      caseTitle ? `We recently helped you with "${caseTitle}". How satisfied were you with how we handled it?` : "How satisfied were you with how we handled your last request?",
      "",
      "Reply with a number from 1 (very unhappy) to 5 (very happy), and a line on why if you like.",
      "",
      "Thank you,",
      brand ?? "The team",
    ].join("\n"),
  };
}

export async function requestFeedbackTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const kind = params.kind === "csat" ? "csat" : params.kind === "nps" ? "nps" : null;
  if (!kind) throw new CrmError("kind must be nps (0 to 10, how likely to recommend) or csat (1 to 5, how satisfied with one case)");
  let caseRecord: SupportCase | null = null;
  if (typeof params.caseId === "string" && params.caseId.trim()) {
    caseRecord = await getCase(ctx, viewer.companyId, params.caseId.trim());
    if (!caseRecord || caseRecord.client.kind !== client.kind || caseRecord.client.id !== client.id) throw new CrmError("That case is not one of this client's cases");
  }
  if (kind === "csat" && !caseRecord) throw new CrmError("A CSAT request is about one case: send caseId (resolve the case first).");
  const { contact, email } = await pickRecipient(ctx, viewer.companyId, client, {
    contactId: typeof params.contactId === "string" ? params.contactId : null,
    toEmail: typeof params.toEmail === "string" ? params.toEmail : null,
  });
  if (contact.emailStatus === "unsubscribed") throw new CrmError(`${email} opted out of email, so no feedback request goes to them.`);
  const past = await listFeedback(ctx, viewer.companyId, client, 100);
  const now = Date.now();
  if (kind === "nps") {
    const recent = past.find((f) => f.kind === "nps" && f.contactId === contact.id && f.status !== "declined" && (f.status === "draft" || (f.requestedAt && now - Date.parse(f.requestedAt) < NPS_COOLDOWN_DAYS * DAY_MS)));
    if (recent) throw new CrmError(`${contact.name} was already asked for NPS in the last ${NPS_COOLDOWN_DAYS} days (or a request is waiting for approval). Ask again later.`);
  } else if (past.some((f) => f.kind === "csat" && f.caseId === caseRecord!.id && f.status !== "declined")) {
    throw new CrmError("This case already has a CSAT request.");
  }
  const feedback: FeedbackRecord = { id: randomUUID(), companyId: viewer.companyId, client, kind, caseId: caseRecord?.id ?? null, contactId: contact.id, toEmail: email, status: "draft", score: null, comment: null, requestedAt: null, answeredAt: null, createdAt: null };
  await insertFeedback(ctx, feedback, viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null);
  const mail = feedbackEmail(kind, contact.name, caseRecord?.title ?? null, await brandName(ctx, viewer.companyId));
  const opened = await requestApproval(ctx, {
    companyId: viewer.companyId,
    kind: "feedback_request",
    client,
    subjectId: feedback.id,
    title: `Approve ${kind === "nps" ? "NPS" : "CSAT"} request to ${name}`,
    intro: [`A ${kind === "nps" ? "net promoter score" : "satisfaction"} request for ${name}${caseRecord ? ` about the case "${caseRecord.title}"` : ""}.`, "Approving sends the email. A reply that starts with a number is recorded as the score; a low score opens an issue for the Account Manager."],
    draft: { to: [{ email, name: contact.name }], subject: mail.subject, text: mail.text, contactId: contact.id },
    checks: ["The question is the standard one and is addressed to the right person.", "Tone: warm and brief.", "This is not a good moment: no open complaint or unpaid-invoice dispute with this client."],
    outward: true,
    actorUserId: viewer.userId,
    wakeReason: "A feedback request needs checking",
  });
  return {
    feedbackId: feedback.id,
    kind,
    to: `${contact.name} <${email}>`,
    approvalIssueId: opened.issueId,
    approvalLink: await approvalLink(ctx, viewer.companyId, opened.issueId),
    next: "A person approves the email by marking the approval issue done. When the client answers by email the score is recorded for you; if they answer another way, call record-feedback.",
  };
}

/** Parses the score a client replied with: the first number in the first line, within the scale. Null when it is unclear. */
export function parseScore(text: string, kind: FeedbackKind): { score: number; comment: string } | null {
  const first = text.replace(/\r/g, "").split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const max = kind === "nps" ? 10 : 5;
  const min = kind === "nps" ? 0 : 1;
  const m = /^(\d{1,2})(?:\s*(?:\/|out of)\s*(\d{1,2}))?\b\s*[-:,.!)]?\s*(.*)$/i.exec(first);
  if (!m) return null;
  const score = Number(m[1]);
  if (m[2] && Number(m[2]) !== max) return null;
  if (!Number.isInteger(score) || score < min || score > max) return null;
  const rest = [m[3] ?? "", ...text.replace(/\r/g, "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0).slice(1)].join(" ").trim();
  return { score, comment: rest.slice(0, 500) };
}

export const LOW_SCORE = { nps: 6, csat: 2 } as const;

export async function answerFeedback(ctx: PluginContext, feedback: FeedbackRecord, score: number, comment: string | null, source: string, now = new Date()): Promise<FeedbackRecord> {
  const done: FeedbackRecord = { ...feedback, status: "answered", score, comment: comment?.slice(0, 500) ?? null, answeredAt: now.toISOString() };
  await saveFeedback(ctx, done);
  const label = feedback.kind === "nps" ? "NPS" : "CSAT";
  await logOnClient(ctx, feedback.companyId, feedback.client, "note", `${label} answer from the client: ${score}${feedback.kind === "nps" ? " of 10" : " of 5"} (${source}).${comment ? ` "${comment.slice(0, 200)}"` : ""}`, `care:feedback:${feedback.id}:answered`);
  if (score <= LOW_SCORE[feedback.kind]) {
    const info = await clientInfo(ctx, feedback.companyId, feedback.client);
    const prefix = await companyPrefix(ctx, feedback.companyId);
    await openIssueOnce(ctx, {
      companyId: feedback.companyId,
      originId: originFor.feedbackLow(feedback.id),
      title: `Unhappy client: ${info?.name ?? "client"} scored ${score}`.slice(0, 200),
      description: [
        `${info?.name ?? "A client"} answered a ${label} request with ${score} (${feedback.kind === "nps" ? "0 to 10" : "1 to 5"}).${comment ? ` They said: "${comment.slice(0, 300)}"` : ""}`,
        "",
        "Call them (or write, through a Mailbox draft a person approves) within a working day: listen, say what you will fix and by when, and log it on the client (`log-activity`). Then record what you did here.",
        "",
        info ? `Client: ${crmLink(prefix, feedback.client.kind, feedback.client.id)}` : "",
        "",
        "**Done when** the follow-up is logged on the client since this issue opened. Closing checks it.",
      ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n"),
      assignee: await teamAssignee(ctx, feedback.companyId),
      wakeReason: "A client gave a low score",
      projectId: await clientProjectOf(ctx, feedback.companyId, feedback.client),
      priority: "high",
    });
  }
  return done;
}

export async function recordFeedbackTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const score = Number(params.score);
  let feedback: FeedbackRecord | null = null;
  if (typeof params.feedbackId === "string" && params.feedbackId.trim()) {
    feedback = await getFeedback(ctx, viewer.companyId, params.feedbackId.trim());
    if (!feedback) throw new CrmError("That feedback request was not found");
    await requireClient(ctx, viewer, feedback.client);
  } else {
    const client = parseClientRef(params.client);
    await requireClient(ctx, viewer, client);
    const kind = params.kind === "csat" ? "csat" : params.kind === "nps" ? "nps" : null;
    if (!kind) throw new CrmError("kind must be nps or csat");
    feedback = { id: randomUUID(), companyId: viewer.companyId, client, kind, caseId: null, contactId: null, toEmail: null, status: "requested", score: null, comment: null, requestedAt: new Date().toISOString(), answeredAt: null, createdAt: null };
    await insertFeedback(ctx, feedback, viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null);
  }
  if (feedback.status === "answered") throw new CrmError("This feedback was already recorded.");
  const [min, max] = feedback.kind === "nps" ? [0, 10] : [1, 5];
  if (!Number.isInteger(score) || score < min || score > max) throw new CrmError(`score must be a whole number from ${min} to ${max} for ${feedback.kind === "nps" ? "NPS" : "CSAT"}`);
  const done = await answerFeedback(ctx, feedback, score, clamp(params.comment, 500), "recorded by hand");
  return { feedbackId: done.id, kind: done.kind, score: done.score, lowScoreIssue: score <= LOW_SCORE[feedback.kind] };
}

/** A client replied to a feedback request: record the score when the reply starts with one. Returns true when it did. */
export async function onFeedbackReply(ctx: PluginContext, companyId: string, feedbackId: string, snippet: string): Promise<boolean> {
  const feedback = await getFeedback(ctx, companyId, feedbackId);
  if (!feedback || feedback.status !== "requested") return false;
  const parsed = parseScore(snippet, feedback.kind);
  if (!parsed) return false;
  await answerFeedback(ctx, feedback, parsed.score, parsed.comment || null, "email reply");
  return true;
}

export const feedbackHooks: MailApprovalHooks = {
  async onSent(ctx, approval, info) {
    const feedback = await getFeedback(ctx, approval.companyId, approval.subjectId);
    if (!feedback || feedback.status !== "draft") return;
    await saveFeedback(ctx, { ...feedback, status: "requested", requestedAt: new Date().toISOString() });
    await logOnClient(ctx, approval.companyId, feedback.client, "email_sent", `${feedback.kind === "nps" ? "NPS" : "CSAT"} request sent to the client.${info.dryRun ? " (canary dry run: not really sent)" : ""}`, `care:feedback:${feedback.id}:sent`, approval.issueId);
  },
  async onRefused(ctx, approval) {
    const feedback = await getFeedback(ctx, approval.companyId, approval.subjectId);
    if (feedback && feedback.status === "draft") await saveFeedback(ctx, { ...feedback, status: "declined" });
  },
  async onFailed(ctx, approval) {
    // The email never went out: the request stops counting as asked (a draft would block the next request for this person for ever,
    // and a draft counts as a recent NPS). The common handler opens the issue; asking again with request-feedback is now possible.
    const feedback = await getFeedback(ctx, approval.companyId, approval.subjectId);
    if (feedback && feedback.status === "draft") await saveFeedback(ctx, { ...feedback, status: "declined" });
  },
};

/** NPS from answered NPS requests: promoters 9-10, detractors 0-6. Null with no answers. */
export function npsOf(feedback: Array<Pick<FeedbackRecord, "kind" | "status" | "score">>): { nps: number; answers: number; promoters: number; passives: number; detractors: number } | null {
  const scores = feedback.filter((f) => f.kind === "nps" && f.status === "answered" && f.score != null).map((f) => f.score as number);
  if (scores.length === 0) return null;
  const promoters = scores.filter((s) => s >= 9).length;
  const detractors = scores.filter((s) => s <= 6).length;
  return { nps: Math.round(((promoters - detractors) / scores.length) * 100), answers: scores.length, promoters, passives: scores.length - promoters - detractors, detractors };
}

export async function feedbackViews(ctx: PluginContext, companyId: string, client: ClientKey) {
  const rows = await listFeedback(ctx, companyId, client, 30);
  return { items: rows.map((f) => ({ feedbackId: f.id, kind: f.kind, status: f.status, score: f.score, comment: f.comment, requestedAt: f.requestedAt, answeredAt: f.answeredAt })), nps: npsOf(rows) };
}
