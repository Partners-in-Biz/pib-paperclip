/**
 * The sales desk's worker side (CRM 0.37.0): the Today queue, logging an
 * outcome, setting a next action with an agent's brief, the agent-facing
 * call list, and Give to agent for a company, contact or deal.
 *
 * Every write goes through the same visibility check as the rest of the CRM
 * (`requireRecord`), so a person or agent only touches what they can see.
 * A brief is the agent's full talking points for a call; it is kept whole
 * (up to BRIEF_MAX characters) because the 280-character clip of
 * `get-contact` lost them before.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { buildHandoffDescription, handoffTitle, inlineData, isLocalAgent, isRunnableAgent } from "@partnersinbiz/pib-plugin-kit/handoff";
import {
  activitiesSince,
  getAccount,
  getContact,
  getDeal,
  insertActivity,
  latestActivitiesOfKind,
  listActivities,
  listLinks,
  listStages,
  saveContact,
  saveDeal,
  table,
} from "./db.js";
import {
  activitySeries,
  batchRows,
  buildQueue,
  dueDateInDays,
  funnel,
  isOutcome,
  isOutcomeChannel,
  outcomeBody,
  outcomeSuggestion,
  queueCounts,
  type DeskActivity,
  type DeskRecordType,
  type QueueItem,
} from "./desk.js";
import { assertLifecycle, assertNextAction, CrmError, type AccountDraft, type ContactDraft, type DealDraft, type NextActionKind, type RecordType, type Viewer } from "./domain.js";
import { readConfig } from "@partnersinbiz/pib-plugin-kit";
import { leadBand } from "./lead-levels.js";
import { companyPrefix, crmLink, refOf } from "./refs.js";

export const BRIEF_MAX = 8000;
const SERIES_DAYS = 28;
/** Activities read for the desk: 90 days back, at most this many rows. */
const ACTIVITY_WINDOW_DAYS = 90;
const ACTIVITY_LIMIT = 5000;
export const GIVE_KIND = "CRM record";

export interface DeskRecords {
  visibleAccounts: AccountDraft[];
  visibleContacts: ContactDraft[];
  visibleDeals: DealDraft[];
  visibleLinks: Array<{ contactId: string; accountId: string; roleLabel: string }>;
  stages: Array<{ id: string; kind: string; name: string; position: number }>;
}

export interface DeskDeps {
  records(ctx: PluginContext, viewer: Viewer): Promise<DeskRecords>;
  requireRecord(ctx: PluginContext, viewer: Viewer, recordType: RecordType, id: string): Promise<AccountDraft | ContactDraft | DealDraft>;
}

async function timezoneOf(ctx: PluginContext, companyId: string): Promise<string> {
  const config = await readConfig(ctx, companyId).catch(() => ({} as Record<string, unknown>));
  const tz = (config as { timezone?: unknown }).timezone;
  return typeof tz === "string" && tz ? tz : "Africa/Johannesburg";
}

function recent(ctx: PluginContext, companyId: string, now: number) {
  return activitiesSince(ctx, companyId, new Date(now - ACTIVITY_WINDOW_DAYS * 86_400_000).toISOString(), ACTIVITY_LIMIT);
}

function deskRecordType(value: unknown): DeskRecordType {
  if (value === "contact" || value === "deal") return value;
  throw new CrmError("recordType must be contact or deal");
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `contact:<id>` works where an id is expected. */
function idOf(value: string | undefined, kind: DeskRecordType): string {
  if (!value) throw new CrmError("recordId is required");
  const prefix = `${kind}:`;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function dueIso(value: unknown, timezone: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new CrmError("dueAt must be an ISO date (2026-11-10) or date-time");
  const text = value.trim();
  // A bare date means noon in the company's timezone, so "today" is today everywhere.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const noon = new Date(`${text}T12:00:00Z`);
    if (Number.isNaN(noon.getTime())) throw new CrmError("dueAt is not a valid date");
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).formatToParts(noon);
      const hourThere = Number(parts.find((p) => p.type === "hour")?.value ?? 12);
      return new Date(noon.getTime() + (12 - hourThere) * 3_600_000).toISOString();
    } catch {
      return noon.toISOString();
    }
  }
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new CrmError("dueAt is not a valid date");
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// The Today view
// ---------------------------------------------------------------------------

export async function deskView(ctx: PluginContext, viewer: Viewer, deps: DeskDeps, now = Date.now()) {
  const [records, timezone, activities] = await Promise.all([deps.records(ctx, viewer), timezoneOf(ctx, viewer.companyId), recent(ctx, viewer.companyId, now)]);
  const visibleIds = new Set([...records.visibleContacts.map((row) => `contact:${row.id}`), ...records.visibleDeals.map((row) => `deal:${row.id}`), ...records.visibleAccounts.map((row) => `company:${row.id}`)]);
  const rows: DeskActivity[] = activities.filter((row) => visibleIds.has(`${row.recordType}:${row.recordId}`));
  const openStageIds = new Set(records.stages.filter((stage) => stage.kind === "open").map((stage) => stage.id));
  const items = buildQueue({
    contacts: records.visibleContacts,
    deals: records.visibleDeals,
    accounts: records.visibleAccounts,
    links: records.visibleLinks,
    openStageIds,
    activities: rows,
    now,
    timezone,
  });
  const touched = new Set(rows.filter((row) => row.recordType === "contact" && ["call", "email", "meeting", "message", "email_sent", "speed_to_lead_sent"].includes(row.kind)).map((row) => row.recordId));
  return {
    timezone,
    items,
    counts: queueCounts(items),
    activity: activitySeries(rows, now, timezone, SERIES_DAYS),
    funnel: funnel({
      contacts: records.visibleContacts,
      deals: records.visibleDeals,
      touchedContactIds: touched,
      wonStageIds: new Set(records.stages.filter((stage) => stage.kind === "won").map((stage) => stage.id)),
      lostStageIds: new Set(records.stages.filter((stage) => stage.kind === "lost").map((stage) => stage.id)),
    }),
    batches: batchRows({ contacts: records.visibleContacts, deals: records.visibleDeals, activities: rows, now, timezone }),
  };
}

// ---------------------------------------------------------------------------
// Next action and outcome
// ---------------------------------------------------------------------------

async function loadTarget(ctx: PluginContext, viewer: Viewer, deps: DeskDeps, params: Record<string, unknown>) {
  const recordType = deskRecordType(params.recordType);
  const recordId = idOf(str(params, "recordId"), recordType);
  const record = (await deps.requireRecord(ctx, viewer, recordType, recordId)) as ContactDraft | DealDraft;
  return { recordType, recordId, record };
}

async function writeNext(ctx: PluginContext, recordType: DeskRecordType, record: ContactDraft | DealDraft, kind: NextActionKind | null, dueAt: string | null) {
  record.nextActionKind = kind;
  record.nextActionDueAt = kind ? dueAt : null;
  if (recordType === "contact") await saveContact(ctx, record as ContactDraft);
  else await saveDeal(ctx, record as DealDraft);
}

/**
 * Sets (or clears) the next action on a contact or deal, with an optional
 * brief: the agent's talking points, kept whole on the timeline. This is how
 * an agent's "call these people" lands in the CRM instead of in an issue.
 */
export async function setNextAction(ctx: PluginContext, viewer: Viewer, deps: DeskDeps, params: Record<string, unknown>, source: "agent" | "human") {
  const { recordType, recordId, record } = await loadTarget(ctx, viewer, deps, params);
  const timezone = await timezoneOf(ctx, viewer.companyId);
  const kind = params.kind == null || params.kind === "" || params.kind === "none" ? null : assertNextAction(params.kind);
  const dueAt = kind ? dueIso(params.dueAt, timezone) : null;
  if (kind && !dueAt && typeof params.inDays === "number") {
    await writeNext(ctx, recordType, record, kind, dueIso(dueDateInDays(Date.now(), Math.max(0, Math.floor(params.inDays)), timezone), timezone));
  } else {
    await writeNext(ctx, recordType, record, kind, dueAt);
  }
  const brief = typeof params.brief === "string" ? params.brief.trim() : "";
  let briefId: string | null = null;
  if (brief) {
    briefId = await insertActivity(ctx, {
      companyId: viewer.companyId,
      recordType,
      recordId,
      kind: "brief",
      body: brief.length > BRIEF_MAX ? `${brief.slice(0, BRIEF_MAX - 1)}…` : brief,
      issueId: str(params, "issueId") ?? null,
      meta: { source, by: source === "agent" ? viewer.agentId : viewer.userId },
    });
  }
  const prefix = await companyPrefix(ctx, viewer.companyId);
  const ref = recordType === "contact" ? refOf("contact", recordId) : `deal:${recordId}`;
  return {
    ref,
    recordType,
    recordId,
    nextActionKind: record.nextActionKind,
    nextActionDueAt: record.nextActionDueAt,
    briefId,
    link: recordType === "contact" ? crmLink(prefix, "contact", recordId) : `${prefix ? `/${prefix}` : ""}/crm?tab=today`,
  };
}

/**
 * Logs what happened on a call, email, meeting or message and sets the next
 * step in one go. Without an explicit next step the outcome's usual one is
 * used ("no answer" → call tomorrow). `lifecycle` is applied only when sent.
 */
export async function logOutcome(ctx: PluginContext, viewer: Viewer, deps: DeskDeps, params: Record<string, unknown>, source: "agent" | "human") {
  const { recordType, recordId, record } = await loadTarget(ctx, viewer, deps, params);
  const channel = params.channel ?? "call";
  if (!isOutcomeChannel(channel)) throw new CrmError("channel must be call, email, meeting or message");
  if (!isOutcome(params.outcome)) throw new CrmError("outcome is required: reached, no_answer, voicemail, busy, wrong_number, meeting_booked, sent, replied or not_interested");
  const outcome = params.outcome;
  const timezone = await timezoneOf(ctx, viewer.companyId);
  const note = typeof params.note === "string" ? params.note.trim().slice(0, 4000) : "";
  const now = Date.now();

  const activityId = await insertActivity(ctx, {
    companyId: viewer.companyId,
    recordType,
    recordId,
    kind: channel,
    body: outcomeBody(channel, outcome, note),
    issueId: str(params, "issueId") ?? null,
    meta: { outcome, channel, source, by: source === "agent" ? viewer.agentId : viewer.userId },
  });

  let kind: NextActionKind | null;
  let dueAt: string | null;
  if ("nextActionKind" in params) {
    kind = params.nextActionKind == null || params.nextActionKind === "" || params.nextActionKind === "none" ? null : assertNextAction(params.nextActionKind);
    dueAt = kind ? dueIso(params.nextActionDueAt, timezone) : null;
  } else {
    const suggestion = outcomeSuggestion(outcome);
    kind = suggestion.kind;
    dueAt = kind && suggestion.inDays != null ? dueIso(dueDateInDays(now, suggestion.inDays, timezone), timezone) : null;
  }
  await writeNext(ctx, recordType, record, kind, dueAt);

  let lifecycle: string | null = null;
  if (recordType === "contact" && typeof params.lifecycle === "string" && params.lifecycle) {
    const contact = record as ContactDraft;
    const next = assertLifecycle(params.lifecycle);
    if (next !== contact.lifecycle) {
      contact.lifecycle = next;
      await saveContact(ctx, contact);
      lifecycle = next;
    }
  }
  // A deal's contact gets the same next step so its own queue row agrees with the deal's.
  if (recordType === "deal") {
    const deal = record as DealDraft;
    if (deal.contactId) {
      const contact = await getContact(ctx, deal.contactId);
      if (contact && contact.companyId === viewer.companyId) await writeNext(ctx, "contact", contact, kind, dueAt);
    }
  }
  return { activityId, recordType, recordId, outcome, channel, nextActionKind: kind, nextActionDueAt: dueAt, lifecycle };
}

// ---------------------------------------------------------------------------
// The agent's call list
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What a person (or the Sales Lead) works through today: every contact and
 * deal with a next action, in buckets, with phone, email, the latest brief
 * and the last touch. `scope` "due" (default) is overdue and today only.
 */
export async function callList(ctx: PluginContext, viewer: Viewer, deps: DeskDeps, params: Record<string, unknown>, now = Date.now()) {
  const view = await deskView(ctx, viewer, deps, now);
  const scope = params.scope === "all" ? "all" : params.scope === "week" ? "week" : "due";
  const kind = str(params, "kind");
  const limit = Math.min(200, Math.max(1, typeof params.limit === "number" ? Math.floor(params.limit) : 50));
  const prefix = await companyPrefix(ctx, viewer.companyId);
  const keep = (item: QueueItem) => {
    if (kind && item.kind !== kind) return false;
    if (scope === "due") return item.bucket === "overdue" || item.bucket === "today";
    if (scope === "week") return item.bucket !== "later";
    return true;
  };
  const items = view.items.filter(keep).slice(0, limit).map((item) => ({
    ref: item.recordType === "contact" ? refOf("contact", item.recordId) : `deal:${item.recordId}`,
    contactRef: item.contactId ? refOf("contact", item.contactId) : null,
    name: item.name,
    company: item.company,
    phone: item.phone,
    email: item.email,
    emailOk: item.emailOk,
    nextAction: item.kind,
    dueAt: item.dueAt,
    bucket: item.bucket,
    lifecycle: item.lifecycle,
    leadBand: item.band,
    deal: item.deal,
    brief: item.brief ? { at: item.brief.at, text: item.brief.body.length > BRIEF_MAX ? `${item.brief.body.slice(0, BRIEF_MAX - 1)}…` : item.brief.body } : null,
    lastTouch: item.lastTouch ? { at: item.lastTouch.at, kind: item.lastTouch.kind, text: clip(item.lastTouch.body, 240) } : null,
    link: item.contactId ? crmLink(prefix, "contact", item.contactId) : item.companyId ? crmLink(prefix, "company", item.companyId) : null,
  }));
  return { scope, timezone: view.timezone, counts: view.counts, total: view.items.filter(keep).length, items, deskLink: `${prefix ? `/${prefix}` : ""}/crm?tab=today` };
}

// ---------------------------------------------------------------------------
// Give to agent
// ---------------------------------------------------------------------------

async function clientProjectId(ctx: PluginContext, companyId: string, kind: "company" | "contact", id: string): Promise<string | null> {
  const rows = await ctx.db.query<{ project_id: string; kind: string | null }>(
    `SELECT project_id, kind FROM ${table(ctx, "client_projects")} WHERE company_id = $1 AND client_kind = $2 AND client_ref = $3 ORDER BY created_at`,
    [companyId, kind, id],
  );
  if (rows.length === 0) return null;
  // The website project is where sales work usually lives; else the first linked one.
  return (rows.find((row) => row.kind === "website") ?? rows[0]!).project_id;
}

function recordTypeOf(value: unknown): RecordType {
  if (value === "company" || value === "contact" || value === "deal") return value;
  throw new CrmError("recordType must be company, contact or deal");
}

function money(amountMinor: number, currency: string): string {
  return `${currency} ${(amountMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Everything the agent needs about the record, as received data, plus the CRM link and the client's project. */
export async function givePrepare(ctx: PluginContext, viewer: Viewer, deps: DeskDeps, params: Record<string, unknown>) {
  const recordType = recordTypeOf(params.recordType);
  const rawId = str(params, "recordId");
  if (!rawId) throw new CrmError("recordId is required");
  const recordId = rawId.replace(/^(company|contact|deal):/, "");
  const record = await deps.requireRecord(ctx, viewer, recordType, recordId);
  const prefix = await companyPrefix(ctx, viewer.companyId);
  const [links, stages, activities] = await Promise.all([
    listLinks(ctx, viewer.companyId),
    recordType === "deal" ? listStages(ctx, (record as DealDraft).pipelineId) : Promise.resolve([]),
    listActivities(ctx, recordType, recordId, 12),
  ]);

  const meta: Array<[string, string | null | undefined]> = [];
  let title = "";
  let link = "";
  let projectId: string | null = null;
  let client: { kind: "company" | "contact"; id: string } | null = null;
  const lines: string[] = [];

  if (recordType === "contact") {
    const contact = record as ContactDraft;
    const companies = await Promise.all(links.filter((row) => row.contactId === contact.id).map(async (row) => ({ role: row.roleLabel, account: await getAccount(ctx, row.accountId) })));
    const first = companies[0]?.account ?? null;
    client = first ? { kind: "company", id: first.id } : { kind: "contact", id: contact.id };
    title = handoffTitle("CRM: ", contact.name, "contact");
    link = crmLink(prefix, "contact", contact.id);
    meta.push(["Contact", contact.name], ["Ref", refOf("contact", contact.id)], ["Lifecycle", contact.lifecycle]);
    meta.push(["Companies", companies.map((row) => (row.account ? `${row.account.name} (${row.role})` : row.role)).join("; ") || "none"]);
    meta.push(["Email", contact.emails.join(", ") || "none"], ["Phone", contact.phones.join(", ") || "none"]);
    meta.push(["Email status", contact.emailStatus ?? "ok"]);
    meta.push(["Next action", contact.nextActionKind ? `${contact.nextActionKind}${contact.nextActionDueAt ? ` due ${contact.nextActionDueAt.slice(0, 10)}` : ""}` : "none"]);
    if (contact.leadScore) meta.push(["Lead score", `${leadBand(contact.leadScore)} (fit ${contact.leadScore.fit}, intent ${contact.leadScore.intent}, urgency ${contact.leadScore.urgency})`]);
    if (contact.tags.length) meta.push(["Tags", contact.tags.join(", ")]);
  } else if (recordType === "company") {
    const account = record as AccountDraft;
    client = { kind: "company", id: account.id };
    title = handoffTitle("CRM: ", account.name, "company");
    link = crmLink(prefix, "company", account.id);
    const people = await Promise.all(links.filter((row) => row.accountId === account.id).map(async (row) => ({ role: row.roleLabel, contact: await getContact(ctx, row.contactId) })));
    meta.push(["Company", account.name], ["Ref", refOf("company", account.id)], ["Lifecycle", account.lifecycle], ["Website", account.domain ?? "none"]);
    meta.push(["People", people.map((row) => (row.contact ? `${row.contact.name} (${row.role})` : row.role)).join("; ") || "none"]);
    meta.push(["Phone", account.phone ?? "none"], ["Billing email", account.billingEmail ?? "none"]);
    if (account.tags.length) meta.push(["Tags", account.tags.join(", ")]);
  } else {
    const deal = record as DealDraft;
    const [account, contact] = await Promise.all([deal.accountId ? getAccount(ctx, deal.accountId) : null, deal.contactId ? getContact(ctx, deal.contactId) : null]);
    client = account ? { kind: "company", id: account.id } : contact ? { kind: "contact", id: contact.id } : null;
    title = handoffTitle("Deal: ", deal.title, "deal");
    link = account ? crmLink(prefix, "company", account.id) : contact ? crmLink(prefix, "contact", contact.id) : `${prefix ? `/${prefix}` : ""}/crm?tab=deals`;
    const stage = stages.find((row) => row.id === deal.stageId);
    meta.push(["Deal", deal.title], ["Deal id", deal.id], ["Stage", stage ? `${stage.name} (${stage.kind})` : deal.stageId], ["Value", deal.amountMinor > 0 ? money(deal.amountMinor, deal.currency) : "not set"]);
    meta.push(["Company", account ? `${account.name} (${refOf("company", account.id)})` : "none"], ["Contact", contact ? `${contact.name} (${refOf("contact", contact.id)})` : "none"]);
    if (contact) meta.push(["Contact email", contact.emails.join(", ") || "none"], ["Contact phone", contact.phones.join(", ") || "none"]);
    meta.push(["Next action", deal.nextActionKind ? `${deal.nextActionKind}${deal.nextActionDueAt ? ` due ${deal.nextActionDueAt.slice(0, 10)}` : ""}` : "none"]);
  }
  if (client) projectId = await clientProjectId(ctx, viewer.companyId, client.kind, client.id).catch(() => null);

  for (const row of activities) {
    lines.push(`${row.createdAt.slice(0, 16).replace("T", " ")} · ${row.kind}: ${row.body}`);
  }
  const description = buildHandoffDescription({
    source: { kind: GIVE_KIND, link, meta },
    receivedText: lines.length ? lines.join("\n\n") : "(No activity logged yet.)",
    readMore: `the CRM tools (get-${recordType === "deal" ? "contact" : recordType} with the ref above, list-deals, call-list)`,
    extra: [
      `Work on this ${recordType} with the CRM tools (\`partnersinbiz.crm:*\`): read it first, log what you do with \`log-activity\` or \`log-outcome\`, and set the next step with \`set-next-action\`. Give id: ${recordType}:${recordId}.`,
      projectId ? "" : "No project is linked to this client, so none was picked. Pick one only if you know whose work it is.",
    ].filter(Boolean),
    footer: ["This hand-off gives no right to send mail or messages. Anything outward goes through the Mailbox's normal draft-and-approve path."],
  });
  return { title, description, projectId: projectId ?? undefined, link };
}

/** After the person created the task: check it is this record's hand-off, log it on the timeline, warn when the agent can't run. */
export async function giveRecord(ctx: PluginContext, viewer: Viewer, deps: DeskDeps, params: Record<string, unknown>) {
  const recordType = recordTypeOf(params.recordType);
  const recordId = (str(params, "recordId") ?? "").replace(/^(company|contact|deal):/, "");
  if (!recordId) throw new CrmError("recordId is required");
  await deps.requireRecord(ctx, viewer, recordType, recordId);
  const issueId = str(params, "issueId");
  if (!issueId) throw new CrmError("issueId is required");
  const issue = (await ctx.issues.get(issueId, viewer.companyId).catch(() => null)) as
    | { id: string; identifier?: string | null; title?: string | null; description?: string | null; assigneeAgentId?: string | null }
    | null;
  if (!issue) throw new CrmError("That task isn't in this company.");
  if (!String(issue.description ?? "").includes(`${recordType}:${recordId}`)) throw new CrmError("That task isn't a hand-off of this record, so it was not linked.");
  const name = issue.identifier ?? issue.title ?? "The task";
  const warnings: string[] = [];
  let agentName: string | null = null;
  if (!issue.assigneeAgentId) warnings.push("No agent is assigned yet. Assign one so it picks the task up.");
  else {
    const agent = (await ctx.agents.get(issue.assigneeAgentId, viewer.companyId).catch(() => null)) as { name?: string; status?: string; adapterType?: string } | null;
    agentName = agent?.name ?? null;
    if (agent?.status && !isRunnableAgent(agent.status)) warnings.push(`${agent.name ?? "The agent"} is ${agent.status.replace(/_/g, " ")}, so it can't run.`);
    else if (agent?.adapterType && !isLocalAgent(agent.adapterType)) warnings.push(`${agent.name ?? "The agent"} runs off this server (${agent.adapterType}), so it may not have the CRM tools.`);
  }
  await insertActivity(ctx, {
    companyId: viewer.companyId,
    recordType,
    recordId,
    kind: "given",
    body: `Given to ${agentName ?? "an agent"}: ${name}${issue.title ? ` · ${inlineData(issue.title, 120).replace(/`/g, "")}` : ""}`,
    issueId: issue.id,
    meta: { issueId: issue.id, identifier: issue.identifier ?? null, agentId: issue.assigneeAgentId ?? null, by: viewer.userId },
  });
  return { message: `Given: ${name}.`, warning: warnings.length ? warnings.join(" ") : null };
}

// Exported for the worker's tool dispatch (the deal's pipeline is needed for its stages).
export { getDeal, latestActivitiesOfKind };
