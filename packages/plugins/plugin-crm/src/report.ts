/**
 * The monthly client report (audit Q1a-4, Q1b-8).
 *
 * On the 1st of the month at 06:00 South African time a job opens one issue per
 * customer, "Monthly report <client> <YYYY-MM>", for the Account Manager, with the
 * numbers already gathered by this code:
 * - the CRM's own records (support cases and their targets, the client's website leads, what
 *   we logged on them, requests we are waiting on, site uptime and certificates, invoices paid);
 * - what the other modules sent (`client.signal`: SEO, Social, Campaigns, Billing, Mailbox);
 * - for a module that has not sent anything, the exact tools to call, and `record-client-signal`
 *   to put the numbers in the report;
 * - the work closed in the client's own project and its notional effort (internal only).
 *
 * The report is stored as a record (`client_reports`: data, Markdown, branded HTML) and as an
 * issue document on the issue, so the agent edits it through tools, never by hand. The agent writes
 * the narrative (`set-report-narrative`), then `send-client-report` drafts the email with the report
 * as its body; the email goes through the approval step (`outbound.ts`) and a closing check holds the
 * issue open until it was sent after approval (or skipped with a reason).
 *
 * There is no public share link: the preview service reads one plugin's table through its own database
 * role and serving the CRM's reports would need new infrastructure. The report travels in the email.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { clientContacts, clientInfo, clientProjectOf, customerClients, hasActiveService, isInternalClient, logOnClient, pickRecipient, type ClientInfo } from "./care-clients.js";
import {
  approvalsOfSubject,
  getHealth,
  getReport,
  getReportById,
  listActions,
  listCases,
  listFeedback,
  listReports,
  listSignals,
  saveReport,
  setReportStatus,
  type ApprovalRecord,
  type ClientKey,
  type ReportNarrative,
  type ReportRecord,
  type ReportStatus,
} from "./care-store.js";
import { MODULE_TITLES, MODULE_TOOLS, REPORT_MODULES, signalFor } from "./client-signals.js";
import { table } from "./db.js";
import { CrmError, type Viewer } from "./domain.js";
import { parseClientRef, requireClient, visibleClients } from "./lookup.js";
import { openIssueOnce } from "./mail.js";
import { listMonitors, listMonitorSites, uptimeFigures } from "./monitor.js";
import { daysUntil } from "./monitor-net.js";
import { originFor } from "./origins.js";
import { approvalLink, requestApproval, withdrawOpenApprovals, type MailApprovalHooks } from "./outbound.js";
import { brandName, companyPrefix, crmLink, refOf } from "./refs.js";
import { currentPeriod, EMPTY_NARRATIVE, escapeHtml, periodBounds, periodLabel, previousPeriod, renderClientMarkdown, renderHtml, renderInternalMarkdown, type MissingModule, type ReportData, type ReportSection } from "./report-render.js";
import { teamAssignee } from "./routing.js";
import { SERVICES } from "./services.js";
import { growthSection } from "./attribution.js";
import { listEventKeys } from "./site-events-store.js";
import { clientProjectIds, getClientProfile, listClientLeads } from "./store.js";

const DAY_MS = 86_400_000;

async function safe<T>(ctx: PluginContext, label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    ctx.logger.info("CRM report part skipped", { part: label, error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

/** The modules a client's services say should have numbers: the ones the services use, and Billing for everyone. */
export function expectedModules(services: readonly string[]): string[] {
  const modules = new Set<string>(["billing"]);
  for (const key of services) {
    const def = SERVICES.find((service) => service.key === key);
    if (def?.module && def.module !== "crm") modules.add(def.module);
  }
  return REPORT_MODULES.filter((module) => modules.has(module));
}

interface ActivityRow {
  record_id: string;
  kind: string;
  body: string;
  created_at: unknown;
}

const avg = (numbers: number[]) => (numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : null);
const round1 = (n: number) => Math.round(n * 10) / 10;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Gathers everything the report says, for one client and month. A part that cannot be read is left out, never guessed. */
export async function gatherReportData(ctx: PluginContext, companyId: string, info: ClientInfo, period: string, now = new Date()): Promise<ReportData> {
  const { from, to } = periodBounds(period);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const inWindow = (at: string | null) => {
    const ms = at ? Date.parse(at) : Number.NaN;
    return Number.isFinite(ms) && ms >= fromMs && ms < toMs;
  };
  const client = info.key;
  const [profile, people, signals, cases, feedback, actions, sites, monitors, projectIds, health] = await Promise.all([
    safe(ctx, "profile", () => getClientProfile(ctx, companyId, client.kind, client.id), null),
    safe(ctx, "people", () => clientContacts(ctx, companyId, client), []),
    safe(ctx, "signals", () => listSignals(ctx, companyId, client), []),
    safe(ctx, "cases", () => listCases(ctx, companyId, client, 300), []),
    safe(ctx, "feedback", () => listFeedback(ctx, companyId, client, 300), []),
    safe(ctx, "actions", () => listActions(ctx, companyId, client, 200), []),
    safe(ctx, "sites", () => listMonitorSites(ctx, companyId), []),
    safe(ctx, "monitors", () => listMonitors(ctx, companyId), []),
    safe(ctx, "projects", () => clientProjectIds(ctx, companyId, client.kind, client.id), []),
    safe(ctx, "health", () => getHealth(ctx, companyId, client), null),
  ]);

  const sections: ReportSection[] = [];
  const have = new Set<string>();

  // What the other modules sent for this month.
  for (const module of REPORT_MODULES) {
    const signal = signalFor(signals, module, period);
    if (!signal) continue;
    have.add(module);
    sections.push({ module, title: MODULE_TITLES[module] ?? module, source: signal.source === "agent" ? "agent" : "event", headline: signal.payload.headline, bullets: signal.payload.bullets, ...(signal.payload.note ? { note: signal.payload.note } : {}) });
  }

  // The CRM's own records.
  const ids = [client.id, ...people.map((person) => person.id)];
  const activities = await safe(ctx, "activities", async () => ctx.db.query<ActivityRow>(
    `SELECT record_id, kind, body, created_at FROM ${table(ctx, "activities")}
      WHERE company_id = $1 AND record_id = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))) AND created_at >= $3::timestamptz AND created_at < $4::timestamptz
      ORDER BY created_at LIMIT 1500`,
    [companyId, JSON.stringify(ids), from, to],
  ), [] as ActivityRow[]);

  const casesOpened = cases.filter((c) => inWindow(c.createdAt));
  const casesResolved = cases.filter((c) => inWindow(c.resolvedAt));
  if (casesOpened.length || casesResolved.length) {
    const firstResponses = casesOpened.filter((c) => c.firstResponseAt).map((c) => (Date.parse(c.firstResponseAt!) - Date.parse(c.createdAt ?? c.firstResponseAt!)) / 3_600_000).filter((h) => h >= 0);
    const csat = feedback.filter((f) => f.kind === "csat" && f.status === "answered" && f.score != null && inWindow(f.answeredAt)).map((f) => f.score as number);
    const headline = [{ label: "Support requests", value: `${casesOpened.length} opened, ${casesResolved.length} resolved`, delta: null as string | null }];
    const first = avg(firstResponses);
    if (first !== null) headline.push({ label: "Average first response", value: `${round1(first)} hours`, delta: null });
    const sat = avg(csat);
    if (sat !== null) headline.push({ label: "Satisfaction", value: `${round1(sat)} of 5 (${plural(csat.length, "answer")})`, delta: null });
    sections.push({ module: "support", title: "Support", source: "crm", headline, bullets: casesOpened.slice(0, 5).map((c) => `${c.title} (${c.status === "resolved" || c.status === "closed" ? "resolved" : "open"})`) });
  }

  // Website: uptime, certificate and domain.
  const own = sites.filter((site) => site.client.kind === client.kind && site.client.id === client.id);
  if (own.length) {
    const states = new Map(monitors.map((m) => [m.siteId, m]));
    const bullets: string[] = [];
    const pcts: number[] = [];
    for (const site of own) {
      const figures = await safe(ctx, "uptime", () => uptimeFigures(ctx, companyId, site.id, period), null);
      const state = states.get(site.id);
      const host = (site.label ?? site.url).replace(/^https?:\/\//, "").replace(/\/$/, "");
      const parts: string[] = [];
      if (figures) {
        pcts.push(figures.pct);
        parts.push(`${figures.pct}% uptime`);
      }
      const tls = daysUntil(state?.tlsExpiresAt ?? null, toMs);
      if (tls !== null) parts.push(`security certificate valid for ${Math.max(0, tls)} more days`);
      const domain = daysUntil(state?.domainExpiresAt ?? null, toMs);
      if (domain !== null) parts.push(`domain renews in ${Math.max(0, domain)} days`);
      if (parts.length) bullets.push(`${host}: ${parts.join(", ")}`);
    }
    if (bullets.length) {
      const signal = signalFor(signals, "website", period);
      sections.push({ module: "website", title: "Your website", source: "crm", headline: [...(pcts.length ? [{ label: "Website uptime", value: `${Math.min(...pcts)}%`, delta: null }] : []), ...(signal?.payload.headline ?? [])], bullets: [...bullets, ...(signal?.payload.bullets ?? [])] });
      have.add("website");
    }
  }

  // Enquiries that came in on the client's own website forms.
  const leads = await safe(ctx, "leads", () => listClientLeads(ctx, companyId, client.kind, client.id, 100), []);
  const leadsInMonth = leads.filter((lead) => inWindow(lead.capturedAt ?? null));
  if (leadsInMonth.length) {
    const bySource = new Map<string, number>();
    for (const lead of leadsInMonth) bySource.set(lead.source, (bySource.get(lead.source) ?? 0) + 1);
    sections.push({ module: "leads", title: "Enquiries for your business", source: "crm", headline: [{ label: "Enquiries received", value: String(leadsInMonth.length), delta: null }], bullets: [...bySource.entries()].map(([source, n]) => `${n} from ${source === "form" ? "your website form" : source}`) });
  }

  // Where the enquiries and the site's visitors came from (site events and the client's forms): only when there is something to say.
  const growth = await safe(ctx, "growth", () => growthSection(ctx, companyId, client, period), null as ReportSection | null);
  if (growth) {
    sections.push(growth);
    have.add("growth");
  }

  // Billing: when Billing sent nothing, what the CRM saw (payments it was told about).
  if (!have.has("billing")) {
    const paid = activities.filter((a) => a.kind === "invoice_paid");
    if (paid.length) sections.push({ module: "billing", title: "Billing", source: "crm", headline: [{ label: "Invoices paid", value: String(paid.length), delta: null }], bullets: paid.slice(0, 5).map((a) => a.body.replace(/\s+Lifecycle set to customer\.$/, "")) });
    if (paid.length) have.add("billing");
  }

  // Our contact with them.
  const contactKinds = activities.filter((a) => ["call", "meeting"].includes(a.kind)).length;
  const emails = activities.filter((a) => a.kind === "email_received" || a.kind === "email_sent").length;
  if (contactKinds || emails) {
    sections.push({ module: "contact", title: "Our work together", source: "crm", headline: [...(contactKinds ? [{ label: "Calls and meetings", value: String(contactKinds), delta: null as string | null }] : []), ...(emails ? [{ label: "Emails exchanged", value: String(emails), delta: null as string | null }] : [])], bullets: [] });
  }

  // What the services say should have numbers but nobody sent.
  const expected = expectedModules(profile?.services ?? []);
  const missing: MissingModule[] = expected
    .filter((module) => !have.has(module) && MODULE_TOOLS[module])
    .map((module) => ({ module, title: MODULE_TITLES[module] ?? module, plugin: MODULE_TOOLS[module]!.plugin, tools: MODULE_TOOLS[module]!.tools, ask: MODULE_TOOLS[module]!.ask }));

  const waitingOnClient = actions.filter((a) => a.status === "waiting" || a.status === "replied").map((a) => ({ title: a.title, days: Math.max(0, Math.floor((now.getTime() - Date.parse(a.requestedAt ?? now.toISOString())) / DAY_MS)) }));

  // Internal: the work closed in the client's own project, and what it cost in agent compute.
  const work = await safe(ctx, "work", async () => {
    if (projectIds.length === 0) return { count: 0, titles: [] as string[] };
    const rows = await ctx.db.query<{ identifier: string | null; title: string }>(
      `SELECT identifier, title FROM public.issues
        WHERE company_id::text = $1 AND status = 'done' AND completed_at >= $2::timestamptz AND completed_at < $3::timestamptz
          AND project_id::text = ANY(ARRAY(SELECT jsonb_array_elements_text($4::jsonb)))
        ORDER BY completed_at DESC LIMIT 100`,
      [companyId, from, to, JSON.stringify(projectIds)],
    );
    return { count: rows.length, titles: rows.slice(0, 12).map((row) => `${row.identifier ? `${row.identifier} ` : ""}${row.title}`) };
  }, { count: 0, titles: [] as string[] });
  const effort = await safe(ctx, "effort", async () => {
    if (projectIds.length === 0) return null;
    const rows = await ctx.db.query<{ cost_cents: number | string; input_tokens: number | string; output_tokens: number | string }>(
      `SELECT cost_cents, input_tokens, output_tokens FROM public.cost_events
        WHERE company_id::text = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz
          AND project_id::text = ANY(ARRAY(SELECT jsonb_array_elements_text($4::jsonb)))
        LIMIT 5000`,
      [companyId, from, to, JSON.stringify(projectIds)],
    );
    return rows.length === 0 && work.count === 0 ? null : { issues: work.count, costCents: rows.reduce((sum, row) => sum + Number(row.cost_cents ?? 0), 0), inputTokens: rows.reduce((sum, row) => sum + Number(row.input_tokens ?? 0), 0), outputTokens: rows.reduce((sum, row) => sum + Number(row.output_tokens ?? 0), 0) };
  }, null as ReportData["effort"]);

  return {
    version: 1,
    period,
    periodLabel: periodLabel(period),
    client: { ref: refOf(client.kind, client.id), name: info.name, website: info.website },
    brand: await brandName(ctx, companyId),
    sections,
    missing,
    waitingOnClient,
    workDone: work,
    effort,
    health: health ? { score: health.score, band: health.band } : null,
  };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

export interface BuiltReport {
  record: ReportRecord;
  data: ReportData;
  created: boolean;
  /** Whether the issue document now holds this build. False with `documentNote` set when it could not be written. */
  documentSaved: boolean;
  documentNote: string | null;
}

export const REPORT_DOC_KEY = "report";

async function reportIssueId(ctx: PluginContext, companyId: string, client: ClientKey, period: string, known: string | null): Promise<string | null> {
  if (known) return known;
  const found = await ctx.issues.list({ companyId, originKind: "plugin:partnersinbiz.crm", originId: originFor.clientReport(client.kind, client.id, period), limit: 1 }).catch(() => []);
  return found[0]?.id ?? null;
}

export interface DocumentSave {
  saved: boolean;
  /** Why it was not saved, in words a person can read. */
  reason?: string;
}

/** Saves of one issue's document run one after another, so the delete and the create of two saves never interleave. */
const saving = new Map<string, Promise<unknown>>();

async function writeReportDocument(ctx: PluginContext, companyId: string, issueId: string, name: string, period: string, markdown: string): Promise<DocumentSave> {
  try {
    // The host refuses to update a document that already exists unless the caller names its latest revision, and a plugin can neither read
    // that revision (no issue.documents.read) nor pass one (the SDK has no field for it). So the working copy is replaced: delete it
    // (a no-op when there is none), then create it again. Hand edits and the old revisions of this document do not survive a rebuild.
    await ctx.issues.documents.delete(issueId, REPORT_DOC_KEY, companyId);
    await ctx.issues.documents.upsert({ issueId, companyId, key: REPORT_DOC_KEY, title: `Monthly report ${name} ${period}`, format: "markdown", body: markdown, changeSummary: "Rebuilt from the CRM and the module numbers" });
    return { saved: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.logger.info("CRM report document not saved", { issueId, error: reason });
    return { saved: false, reason: reason.slice(0, 200) };
  }
}

/** Replaces the working copy on the report issue (issue document, key `report`). Never throws: a host that refuses it is logged and reported. */
export function saveReportDocument(ctx: PluginContext, companyId: string, issueId: string, name: string, period: string, markdown: string): Promise<DocumentSave> {
  const run = (saving.get(issueId) ?? Promise.resolve()).then(() => writeReportDocument(ctx, companyId, issueId, name, period, markdown));
  saving.set(issueId, run);
  void run.then(() => {
    if (saving.get(issueId) === run) saving.delete(issueId);
  });
  return run;
}

/** What a tool says when the issue document was not updated: the report is stored either way, so the agent works from the tool result. */
function documentNoteOf(issueId: string | null, save: DocumentSave): string | null {
  if (save.saved) return null;
  if (!issueId) return "There is no report issue for this month yet (the monthly job opens it), so no issue document was written. The report itself is stored.";
  return `The report document on the issue was NOT updated (${save.reason ?? "the host refused it"}), so it may be out of date. The report itself is stored and the email is built from it: work from this result, not from the document.`;
}

/**
 * Builds (or rebuilds) one report. One record per client and month: asking again updates the numbers and keeps the narrative, the
 * status and the issue. A report that was sent is never rewritten. `dryRun` returns what it would say and stores nothing.
 */
export async function buildClientReport(
  ctx: PluginContext,
  companyId: string,
  client: ClientKey,
  period: string,
  options: { dryRun?: boolean; builtBy?: string | null; now?: Date } = {},
): Promise<BuiltReport | { dryRun: true; data: ReportData; markdown: string }> {
  const now = options.now ?? new Date();
  const info = await clientInfo(ctx, companyId, client);
  if (!info) throw new CrmError("That client was not found");
  const existing = await getReport(ctx, companyId, client, period);
  if (existing && (existing.status === "sent" || existing.status === "dry_run") && !options.dryRun) {
    return { record: existing, data: existing.data as unknown as ReportData, created: false, documentSaved: false, documentNote: null };
  }
  const data = await gatherReportData(ctx, companyId, info, period, now);
  const narrative = existing?.narrative ?? EMPTY_NARRATIVE;
  const markdown = renderInternalMarkdown(data, narrative);
  if (options.dryRun) return { dryRun: true, data, markdown };
  const issueId = await reportIssueId(ctx, companyId, client, period, existing?.issueId ?? null);
  await saveReport(ctx, {
    companyId,
    client,
    period,
    status: existing?.status ?? "built",
    narrative,
    data: data as unknown as Record<string, unknown>,
    markdown: renderClientMarkdown(data, narrative),
    html: renderHtml(data, narrative),
    issueId,
    approvalId: existing?.approvalId ?? null,
    builtBy: options.builtBy ?? null,
  });
  const record = (await getReport(ctx, companyId, client, period))!;
  const save: DocumentSave = issueId ? await saveReportDocument(ctx, companyId, issueId, info.name, period, markdown) : { saved: false };
  return { record, data, created: !existing, documentSaved: save.saved, documentNote: documentNoteOf(issueId, save) };
}

function summaryOf(data: ReportData) {
  return {
    sections: data.sections.map((s) => ({ module: s.module, title: s.title, source: s.source, lines: s.headline.length + s.bullets.length })),
    missing: data.missing.map((m) => ({ module: m.module, plugin: m.plugin, tools: m.tools, ask: m.ask })),
    waitingOnClient: data.waitingOnClient.length,
    workDone: data.workDone.count,
  };
}

function periodParam(value: unknown, now: Date): string {
  if (value == null || value === "") return previousPeriod(now);
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new CrmError("period must be YYYY-MM, e.g. 2026-09");
  if (value > currentPeriod(now)) throw new CrmError("That month has not started yet.");
  return value;
}

/** `build-client-report`: idempotent per client and month, with a dry run. */
export async function buildClientReportTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const now = new Date();
  const period = periodParam(params.period, now);
  const builtBy = viewer.agentId ? `agent:${viewer.agentId}` : viewer.userId ? `user:${viewer.userId}` : null;
  if (params.dryRun === true) {
    const dry = (await buildClientReport(ctx, viewer.companyId, client, period, { dryRun: true, builtBy, now })) as { data: ReportData; markdown: string };
    return { dryRun: true, client: refOf(client.kind, client.id), name, period, stored: false, ...summaryOf(dry.data), preview: dry.markdown.slice(0, 3000), next: "Nothing was stored. Run it again without dryRun to build the report." };
  }
  const built = (await buildClientReport(ctx, viewer.companyId, client, period, { builtBy, now })) as BuiltReport;
  const sent = built.record.status === "sent" || built.record.status === "dry_run";
  const data = built.data;
  return {
    reportId: built.record.id,
    client: refOf(client.kind, client.id),
    name,
    period,
    status: built.record.status,
    created: built.created,
    ...(sent ? { alreadySent: true, sentAt: built.record.sentAt, note: "This report was already sent, so it was left as it was." } : summaryOf(data)),
    narrativeWritten: built.record.narrative.summary.trim().length > 0,
    issueId: built.record.issueId,
    documentSaved: built.documentSaved,
    ...(built.documentNote ? { documentNote: built.documentNote } : {}),
    next: sent
      ? "Nothing to do."
      : "Record any missing module numbers (record-client-signal), write the summary (set-report-narrative), build again, then send-client-report. A person approves the email.",
  };
}

/** `set-report-narrative`: the agent's words on how the month went. Re-renders the report. */
export async function setReportNarrativeTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  await requireClient(ctx, viewer, client);
  const period = periodParam(params.period, new Date());
  const summary = typeof params.summary === "string" ? params.summary.trim().slice(0, 1500) : "";
  const list = (value: unknown, max: number) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 300)).filter(Boolean).slice(0, max) : []);
  const narrative: ReportNarrative = { summary, highlights: list(params.highlights, 6), next: list(params.next, 6) };
  if (summary.length < 40) throw new CrmError("summary is the heart of the report: write 3 to 5 plain sentences (at least 40 characters) on how the month went for the client");
  const existing = await getReport(ctx, viewer.companyId, client, period);
  if (existing && (existing.status === "sent" || existing.status === "dry_run")) throw new CrmError("This report was already sent; its words cannot change.");
  if (!existing) await buildClientReport(ctx, viewer.companyId, client, period, { builtBy: viewer.agentId ? `agent:${viewer.agentId}` : null });
  const current = (await getReport(ctx, viewer.companyId, client, period))!;
  const info = (await clientInfo(ctx, viewer.companyId, client))!;
  const data = current.data as unknown as ReportData;
  await saveReport(ctx, {
    companyId: viewer.companyId,
    client,
    period,
    status: current.status,
    narrative,
    data: current.data,
    markdown: renderClientMarkdown(data, narrative),
    html: renderHtml(data, narrative),
    issueId: current.issueId,
    approvalId: current.approvalId,
    builtBy: current.builtBy,
  });
  const save: DocumentSave = current.issueId ? await saveReportDocument(ctx, viewer.companyId, current.issueId, info.name, period, renderInternalMarkdown(data, narrative)) : { saved: false };
  const documentNote = documentNoteOf(current.issueId, save);
  return { client: refOf(client.kind, client.id), period, narrativeSaved: true, documentSaved: save.saved, ...(documentNote ? { documentNote } : {}), next: "Build again to pull in late numbers, then send-client-report." };
}

const MIN_SEND_SUMMARY = 40;

/** `send-client-report`: the email (the report as its body) goes to approval; nothing is sent here. */
export async function sendClientReportTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  const name = await requireClient(ctx, viewer, client);
  const now = new Date();
  const period = periodParam(params.period, now);
  const existing = await getReport(ctx, viewer.companyId, client, period);
  if (existing?.status === "sent" || existing?.status === "dry_run") throw new CrmError(`The ${periodLabel(period)} report was already sent${existing.sentAt ? ` on ${existing.sentAt.slice(0, 10)}` : ""}.`);
  if (existing?.status === "skipped") throw new CrmError("This report was skipped. Build it again with build-client-report only if the skip was a mistake (ask a person).");
  // The numbers are refreshed right before sending, so a late signal is in the email.
  const built = (await buildClientReport(ctx, viewer.companyId, client, period, { builtBy: viewer.agentId ? `agent:${viewer.agentId}` : null, now })) as BuiltReport;
  const narrative = built.record.narrative;
  if (narrative.summary.trim().length < MIN_SEND_SUMMARY) throw new CrmError("The summary is not written. Write 3 to 5 plain sentences with set-report-narrative first.");
  const approvals = await approvalsOfSubject(ctx, viewer.companyId, "client_report", built.record.id);
  const open = approvals.find((a) => a.status === "open" || a.status === "approved");
  if (open) return { reportId: built.record.id, status: built.record.status, approvalIssueId: open.issueId, approvalLink: await approvalLink(ctx, viewer.companyId, open.issueId), note: "This report is already waiting for approval." };
  const { contact, email } = await pickRecipient(ctx, viewer.companyId, client, {
    contactId: typeof params.contactId === "string" ? params.contactId : null,
    toEmail: typeof params.toEmail === "string" ? params.toEmail : null,
  });
  const first = contact.name.trim().split(/\s+/)[0] || "there";
  const note = typeof params.message === "string" && params.message.trim() ? `${params.message.trim().slice(0, 1000)}\n\n` : "";
  const text = `Hi ${first},\n\n${note}Here is your ${built.data.periodLabel} report.\n\n${built.record.markdown}`;
  const html = `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px">Hi ${escapeHtml(first)},</p>${note ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px">${escapeHtml(note.trim())}</p>` : ""}${built.record.html}`;
  const opened = await requestApproval(ctx, {
    companyId: viewer.companyId,
    kind: "client_report",
    client,
    subjectId: built.record.id,
    seq: approvals.length + 1,
    title: `Approve report email to ${name}: ${built.data.periodLabel}`,
    intro: [
      `The ${built.data.periodLabel} report for ${name}${built.record.issueId ? ` (the working copy is the report document on issue ${built.record.issueId})` : ""}. Approving sends it to ${contact.name}.`,
      built.data.missing.length ? `**Not in the report:** ${built.data.missing.map((m) => m.title).join(", ")} (no numbers were recorded for them).` : "",
    ].filter(Boolean),
    draft: { to: [{ email, name: contact.name }], subject: `Your ${built.data.periodLabel} report from ${built.data.brand ?? "us"}`, text, html, contactId: contact.id },
    checks: [
      "Every number and claim in the report is true for this client and this month (compare with the module pages if in doubt).",
      "The summary reads plainly and honestly: it does not hide a bad month or promise results.",
      "Nothing internal is in it: no ticket titles, costs, agent names or other clients.",
      "The recipient is the right person at the client.",
    ],
    outward: true,
    actorUserId: viewer.userId,
    wakeReason: "A client report needs checking before it is sent",
  });
  await setReportStatus(ctx, viewer.companyId, built.record.id, { status: "awaiting_approval", approvalId: opened.approvalId });
  return {
    reportId: built.record.id,
    client: refOf(client.kind, client.id),
    period,
    status: "awaiting_approval" as const,
    to: `${contact.name} <${email}>`,
    approvalIssueId: opened.issueId,
    approvalLink: await approvalLink(ctx, viewer.companyId, opened.issueId),
    next: "A person approves by marking the approval issue done; the Mailbox then sends it. Leave your report issue open until it is sent: closing it earlier is reopened.",
  };
}

/** `skip-client-report`: there is nothing to report this month (a new client, a paused service). The reason is kept. */
export async function skipClientReportTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = parseClientRef(params.client);
  await requireClient(ctx, viewer, client);
  const period = periodParam(params.period, new Date());
  const reason = typeof params.reason === "string" ? params.reason.trim().slice(0, 500) : "";
  if (reason.length < 15) throw new CrmError("Say why there is no report this month (at least a sentence) in `reason`.");
  let record = await getReport(ctx, viewer.companyId, client, period);
  if (!record) {
    await buildClientReport(ctx, viewer.companyId, client, period, { builtBy: viewer.agentId ? `agent:${viewer.agentId}` : null });
    record = (await getReport(ctx, viewer.companyId, client, period))!;
  }
  if (record.status === "sent" || record.status === "dry_run") throw new CrmError("This report was already sent.");
  if ((await approvalsOfSubject(ctx, viewer.companyId, "client_report", record.id)).some((a) => a.status === "approved")) {
    throw new CrmError("The email for this report is already approved and queued in the Mailbox, so it cannot be skipped any more.");
  }
  await setReportStatus(ctx, viewer.companyId, record.id, { status: "skipped" });
  // An email still waiting for a person must not be approved and sent for a report that was skipped.
  await withdrawOpenApprovals(ctx, viewer.companyId, ["client_report"], record.id, "report-skipped", "The report was skipped, so its email is not needed.");
  await logOnClient(ctx, viewer.companyId, client, "note", `The ${periodLabel(period)} report was skipped: ${reason}`, `care:report:${record.id}:skipped`, record.issueId);
  return { reportId: record.id, status: "skipped" as const, reason };
}

export async function listClientReportsTool(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const client = params.client == null || params.client === "" ? null : parseClientRef(params.client);
  if (client) await requireClient(ctx, viewer, client);
  // With no client named, only the clients this viewer may see: the same rule the CRM's other lists follow.
  const seen = client ? null : await visibleClients(ctx, viewer);
  const rows = (await listReports(ctx, viewer.companyId, client, 24)).filter((r) => !seen || seen.has(r.client.kind, r.client.id));
  const period = typeof params.period === "string" && params.period ? params.period : null;
  return { reports: rows.filter((r) => !period || r.period === period).map((r) => ({ reportId: r.id, client: refOf(r.client.kind, r.client.id), period: r.period, status: r.status, narrativeWritten: r.narrative.summary.trim().length > 0, builtAt: r.builtAt, sentAt: r.sentAt, issueId: r.issueId })) };
}

/** The workspace card: a client's reports, newest first. */
export async function reportViews(ctx: PluginContext, companyId: string, client: ClientKey) {
  return (await listReports(ctx, companyId, client, 12)).map((r) => ({ reportId: r.id, period: r.period, periodLabel: periodLabel(r.period), status: r.status, narrativeWritten: r.narrative.summary.trim().length > 0, builtAt: r.builtAt, sentAt: r.sentAt, issueId: r.issueId }));
}

// ---------------------------------------------------------------------------
// After the approval
// ---------------------------------------------------------------------------

async function tellReportAgent(ctx: PluginContext, record: ReportRecord, text: string): Promise<void> {
  if (!record.issueId) return;
  await ctx.issues.createComment(record.issueId, text, record.companyId).catch(() => undefined);
  await wakeIssue(ctx, record.issueId, record.companyId, "The client report email was decided");
}

/** Why an approved report email must not go out after all, or null: the report moved on (skipped, or already sent) while the approval waited. */
export async function reportEmailProblem(ctx: PluginContext, approval: ApprovalRecord): Promise<string | null> {
  if (approval.kind !== "client_report") return null;
  const record = await getReportById(ctx, approval.companyId, approval.subjectId);
  if (!record) return "The report this email belongs to no longer exists.";
  if (record.status === "awaiting_approval") return null;
  if (record.status === "skipped") return "The report was skipped.";
  if (record.status === "sent" || record.status === "dry_run") return "This report was already sent.";
  return "The report was changed after this email was drafted: build it again and send it for approval once more.";
}

export const reportHooks: MailApprovalHooks = {
  async onSent(ctx, approval, info) {
    const record = await getReportById(ctx, approval.companyId, approval.subjectId);
    if (!record) return;
    await setReportStatus(ctx, approval.companyId, record.id, { status: info.dryRun ? "dry_run" : "sent", sentNow: true });
    await logOnClient(ctx, approval.companyId, record.client, "email_sent", `Monthly report for ${periodLabel(record.period)} sent to the client.${info.dryRun ? " (canary dry run: not really sent)" : ""}`, `care:report:${record.id}:sent`, record.issueId);
    await tellReportAgent(ctx, record, `The ${periodLabel(record.period)} report was approved and sent${info.dryRun ? " (canary dry run)" : ""}. Mark this issue done.`);
  },
  async onRefused(ctx, approval, by) {
    const record = await getReportById(ctx, approval.companyId, approval.subjectId);
    if (!record) return;
    await setReportStatus(ctx, approval.companyId, record.id, { status: "built" });
    await tellReportAgent(ctx, record, `A person (${by}) refused to send the ${periodLabel(record.period)} report. Read why on the approval issue (${approval.issueId ?? "no issue"}), fix what they flagged with set-report-narrative or record-client-signal, build again and send-client-report once more. Or skip it with skip-client-report if there is nothing to send.`);
  },
  async onFailed(ctx, approval, error) {
    const record = await getReportById(ctx, approval.companyId, approval.subjectId);
    if (!record) return;
    await setReportStatus(ctx, approval.companyId, record.id, { status: "built" });
    await tellReportAgent(ctx, record, `The ${periodLabel(record.period)} report email could not be sent: ${error}. Fix the cause (a wrong address on the contact, for instance) and send-client-report again.`);
  },
};

// ---------------------------------------------------------------------------
// The monthly job
// ---------------------------------------------------------------------------

/**
 * What makes a month worth a report for a client with no service on its profile: numbers a module sent, a support case, an enquiry, a
 * payment or work closed for them. An uptime figure or a logged call alone is not: nothing happened that the client would want to read.
 */
export function reportHasSubstance(data: ReportData): boolean {
  return data.workDone.count > 0 || data.sections.some((section) => section.module !== "website" && section.module !== "contact");
}

/**
 * Whether a customer has anything to report on. A service on its profile always is: the client pays for something, so they hear from us
 * every month. Without one, the client needs a way for numbers to exist (a module's signal, a website, a linked project) and, when `period`
 * is given, the month must have substance (`reportHasSubstance`): most customers are known to the CRM only through a project link, and
 * a link alone would open a report issue (and wake an agent) for every one of them every month.
 */
export async function worthReporting(ctx: PluginContext, companyId: string, info: ClientInfo, period?: string, now = new Date()): Promise<boolean> {
  if (isInternalClient(info)) return false;
  if (await hasActiveService(ctx, companyId, info.key)) return true;
  const [signals, sites, projects, eventKeys] = await Promise.all([
    listSignals(ctx, companyId, info.key).catch(() => []),
    listMonitorSites(ctx, companyId).catch(() => []),
    clientProjectIds(ctx, companyId, info.key.kind, info.key.id).catch(() => [] as string[]),
    listEventKeys(ctx, companyId, { kind: info.key.kind, id: info.key.id }).catch(() => []),
  ]);
  // A site with a visit counter has numbers to report; whether this month has any is decided below.
  const candidate = signals.length > 0 || eventKeys.length > 0 || sites.some((site) => site.client.kind === info.key.kind && site.client.id === info.key.id) || projects.length > 0;
  if (!candidate || !period) return candidate;
  return reportHasSubstance(await gatherReportData(ctx, companyId, info, period, now));
}

function reportIssueDescription(data: ReportData, info: ClientInfo, link: string, reportLink: string | null): string {
  const lines = [
    `The ${data.periodLabel} report for **${info.name}** (${link}). The numbers the CRM and the modules already hold are gathered and stored; the working copy is the **report** document on this issue.`,
    "",
    "**What is in it:**",
    ...(data.sections.length ? data.sections.map((s) => `- ${s.title}: ${s.source === "crm" ? "from the CRM's own records" : s.source === "agent" ? "recorded by an agent" : "sent by the module"}`) : ["- Nothing yet: no module has numbers for this client and month."]),
  ];
  if (data.missing.length) {
    lines.push("", "**Not in it yet. Read these for this client and month, then record them:**");
    for (const m of data.missing) lines.push(`- ${m.title} (\`${m.plugin}\`): call ${m.tools.map((t) => `\`${t}\``).join(", ")}: ${m.ask}. Then \`record-client-signal\` (module \`${m.module}\`, period \`${data.period}\`).`);
  }
  lines.push(
    "",
    "**Your steps:**",
    `1. Record the missing numbers above (\`record-client-signal\`), or leave a module out when the client does not use it.`,
    `2. \`build-client-report\` (client, period \`${data.period}\`) to pull them in. Add \`dryRun\` true to look first; it is safe to run again.`,
    "3. Write the summary with `set-report-narrative`: 3 to 5 plain sentences on how the month went, highlights the client will care about, and what happens next month. Honest, no jargon, no internal ticket titles.",
    "4. `send-client-report`. It drafts the email with the report as its body and opens an approval; a person approves, then the Mailbox sends it. You cannot send it yourself.",
    "5. When you are told it was sent, mark this issue done. If there is genuinely nothing to report, `skip-client-report` with the reason.",
    "",
    "**Done when** the report was sent after approval, or skipped with a reason. Closing checks it.",
  );
  if (reportLink) lines.push("", `Client page: ${reportLink}`);
  return lines.join("\n");
}

/** Opens the Account Manager's issue for a report that has none. */
export async function ensureReportIssue(ctx: PluginContext, companyId: string, info: ClientInfo, record: ReportRecord): Promise<string> {
  const prefix = await companyPrefix(ctx, companyId);
  const link = crmLink(prefix, info.key.kind, info.key.id);
  const data = record.data as unknown as ReportData;
  return openIssueOnce(ctx, {
    companyId,
    originId: originFor.clientReport(info.key.kind, info.key.id, record.period),
    title: `Monthly report ${info.name} ${record.period}`.slice(0, 200),
    description: reportIssueDescription(data, info, link, null),
    assignee: await teamAssignee(ctx, companyId),
    wakeReason: "A monthly client report is due",
    projectId: await clientProjectOf(ctx, companyId, info.key),
  });
}

export interface ReportRun {
  built: number;
  opened: number;
  skipped: number;
}

/**
 * For every customer worth reporting on (`worthReporting`: a service on the profile, or a month with something in it): build last month's report and open the issue, once. Called by the monthly job (1st, 06:00 SAST)
 * and, for the first days of the month, by the hourly care job as a catch-up, so a missed run is not a missed month.
 */
export async function runMonthlyReports(ctx: PluginContext, companyId: string, now = new Date(), limit = 40): Promise<ReportRun> {
  const run: ReportRun = { built: 0, opened: 0, skipped: 0 };
  const period = previousPeriod(now);
  for (const info of await customerClients(ctx, companyId)) {
    if (run.opened >= limit) break;
    try {
      if (!(await worthReporting(ctx, companyId, info, period, now))) {
        run.skipped += 1;
        continue;
      }
      const existing = await getReport(ctx, companyId, info.key, period);
      if (existing?.issueId) continue;
      const built = (await buildClientReport(ctx, companyId, info.key, period, { builtBy: "system:monthly-report", now })) as BuiltReport;
      run.built += built.created ? 1 : 0;
      const issueId = await ensureReportIssue(ctx, companyId, info, built.record);
      // Link the issue and put the working copy on it (the first build had no issue to hold it).
      await saveReport(ctx, {
        companyId, client: info.key, period, status: built.record.status, narrative: built.record.narrative, data: built.record.data,
        markdown: built.record.markdown, html: built.record.html, issueId, approvalId: built.record.approvalId, builtBy: built.record.builtBy,
      });
      await saveReportDocument(ctx, companyId, issueId, info.name, period, renderInternalMarkdown(built.data, built.record.narrative));
      run.opened += 1;
    } catch (error) {
      ctx.logger.info("CRM monthly report skipped a client", { companyId, client: refOf(info.key.kind, info.key.id), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return run;
}

// ---------------------------------------------------------------------------
// Done-check and Cockpit
// ---------------------------------------------------------------------------

export type CheckResult = { done: true } | { done: false; missing: string[] };

/** Closing a report issue: the report was sent after approval, or skipped with a reason. */
export async function reportIssueResolved(ctx: PluginContext, companyId: string, originId: string): Promise<CheckResult> {
  const m = /^crm:client-report:(company|contact):([^:]+):(\d{4}-\d{2})$/.exec(originId);
  if (!m) return { done: true };
  const client: ClientKey = { kind: m[1] as "company" | "contact", id: m[2]! };
  const info = await clientInfo(ctx, companyId, client);
  if (!info || info.lifecycle !== "customer") return { done: true };
  const record = await getReport(ctx, companyId, client, m[3]!);
  if (!record) return { done: false, missing: [`No report exists for ${m[3]} yet: \`build-client-report\`, write the summary (\`set-report-narrative\`), then \`send-client-report\`.`] };
  if (record.status === "sent" || record.status === "dry_run" || record.status === "skipped") return { done: true };
  if (record.status === "awaiting_approval") return { done: false, missing: ["The report email is waiting for a person's approval. Leave this issue open (in review); you are told when it is sent."] };
  return {
    done: false,
    missing: [record.narrative.summary.trim().length < MIN_SEND_SUMMARY ? "The report has no summary and has not been sent: write it with `set-report-narrative`, then `send-client-report`." : "The report was built but not sent: `send-client-report` (a person approves it), or `skip-client-report` with the reason."],
  };
}

/** Cockpit: customers whose last month's report is still unsent after the 10th (SAST). Amber: a reminder to finish, not a fault. */
export async function reportsHealth(ctx: PluginContext, companyId: string, now = new Date()) {
  const sast = new Date(now.getTime() + 2 * 3_600_000);
  const period = previousPeriod(now);
  const customers = (await customerClients(ctx, companyId)).filter((info) => !isInternalClient(info));
  const reports = await listReports(ctx, companyId, null, 200).then((rows) => rows.filter((r) => r.period === period));
  const open = reports.filter((r) => r.status === "built" || r.status === "awaiting_approval");
  const late = sast.getUTCDate() > 10 ? open : [];
  if (late.length === 0) {
    return { key: "client-reports", title: "Monthly client reports", status: "ok" as const, detail: reports.length ? `${reports.length} report${reports.length === 1 ? "" : "s"} for ${periodLabel(period)}, ${open.length} still being finished.` : customers.length ? `No ${periodLabel(period)} reports opened yet.` : "No customers to report on." };
  }
  return {
    key: "client-reports",
    title: "Monthly client reports",
    status: "warn" as const,
    detail: `${late.length} ${periodLabel(period)} report${late.length === 1 ? " is" : "s are"} still not sent after the 10th.`,
    href: "/crm",
    fix: "The Account Manager has an issue for each: write the summary, send it for approval, or skip it with a reason.",
    since: late.map((r) => r.builtAt).filter((at): at is string => Boolean(at)).sort()[0] ?? null,
  };
}

