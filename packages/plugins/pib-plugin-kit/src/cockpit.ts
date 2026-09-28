/**
 * Company Cockpit contract: one place where a person sees what the agents
 * did, what is waiting on them, the money, the pipeline, marketing results,
 * agent cost/quality, and system health.
 *
 * - Every PiB plugin serves `GET /cockpit?companyId=` (`COCKPIT_ROUTE`)
 *   returning a `CockpitSnapshot`, and pushes it hourly as
 *   `cockpit.snapshot` (`publishCockpitSnapshot`) so the Cockpit plugin's
 *   jobs (health alerts, the Operator's daily brief) work without calling
 *   other plugins.
 * - The Cockpit plugin (`partnersinbiz.cockpit`) owns the company's team
 *   roles (Operator, Reviewer) and broadcasts them as `roles.updated`
 *   (re-emitted hourly). Plugins keep a copy (`registerRoleWatch`) and route
 *   outward-facing approvals to the Reviewer first (`reviewerAgentId`).
 * - Hand-offs between plugins use the events in `HANDOFF_EVENTS`.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { ClientKind } from "./client-ref.js";
import { PIB_PLUGINS } from "./contracts.js";
import { teamRoleHealth, type TeamRoleKey } from "./team.js";
import type { FlowStageReport } from "./flows.js";

export const COCKPIT_PLUGIN = "partnersinbiz.cockpit";

export const COCKPIT_EVENTS = {
  /** Any plugin → Cockpit. Payload: `CockpitSnapshot`. */
  snapshot: "cockpit.snapshot",
  /** Cockpit → every plugin. Payload: `RolesPayload`. */
  rolesUpdated: "roles.updated",
} as const;

export const COCKPIT_ROUTE = {
  routeKey: "cockpit",
  method: "GET",
  path: "/cockpit",
  auth: "board",
  capability: "api.routes.register",
  companyResolution: { from: "query", key: "companyId" },
} as const;

export type Tone = "ok" | "warn" | "bad" | "neutral";

export interface CockpitKpi {
  /** Stable key, e.g. `cash`, `overdue`, `pipeline`, `scheduled_posts`. */
  key: string;
  label: string;
  /** Display value, already formatted and short (e.g. "R 12,400.00"). Put any detail in `hint`. */
  value: string;
  /** One short line under the value, e.g. "3 invoices, 1 over a day old" or "as at 27 Sep". */
  hint?: string | null;
  /** Raw number for sorting/trends when it makes sense (minor units for money). */
  raw?: number | null;
  tone?: Tone;
  /** Change vs the previous period, e.g. "+12% vs last week". */
  delta?: string | null;
  href?: string | null;
  /** Grouping on the Cockpit: money, pipeline, marketing, delivery, people. */
  group: "money" | "pipeline" | "marketing" | "delivery" | "people" | "other";
}

export type HealthStatus = "ok" | "warn" | "bad";

export interface HealthCheck {
  /** Stable key, e.g. `job:publish-due`, `outbox`, `token:x:<accountId>`. */
  key: string;
  title: string;
  status: HealthStatus;
  detail?: string | null;
  /** Where a person (or the Operator) fixes it. */
  href?: string | null;
  /** What to do, one or two steps. */
  fix?: string | null;
  /** ISO time the problem started, when known. */
  since?: string | null;
}

export interface WaitingItem {
  /** Stable key so the Cockpit can dedupe, e.g. `approval:<issueId>`. */
  key: string;
  title: string;
  /** Why a person is needed. */
  why: string;
  href?: string | null;
  issueId?: string | null;
  /** money / legal / grant / judgement / review — drives ordering. */
  kind: "money" | "legal" | "grant" | "judgement" | "review" | "other";
  since?: string | null;
}

export interface ActivityItem {
  at: string;
  /** Short past-tense line: "Published 3 posts for Northwind", "Posted JNL-000012". */
  text: string;
  href?: string | null;
  agentId?: string | null;
}

export interface QualityMetric {
  /** e.g. `approvals_rejected_rate`, `decisions_corrected_rate`, `publish_failures`. */
  key: string;
  label: string;
  value: string;
  raw?: number | null;
  tone?: Tone;
  /** Agent this measures, when it is about one agent. */
  agentId?: string | null;
}

export interface CockpitSnapshot {
  plugin: string;
  title: string;
  checkedAt: string;
  kpis: CockpitKpi[];
  health: HealthCheck[];
  waiting: WaitingItem[];
  /** Most recent notable things the plugin (or its agent) did, newest first, ≤ 10. */
  activity: ActivityItem[];
  quality: QualityMetric[];
  /** The team roles this plugin staffs and the agent linked to each (the Cockpit shares them in `roles.updated`). */
  team?: TeamMemberReport[];
  /** Live numbers for the company-graph stages this plugin owns (kit `FLOWS`); the Cockpit's Flows view draws them. */
  flows?: FlowStageReport[];
}

export interface TeamMemberReport {
  role: TeamRoleKey;
  agentId: string | null;
  /** Paperclip agent status (`active`, `idle`, `paused`, `error`, …) when known. */
  status?: string | null;
}

export function emptySnapshot(plugin: string, title: string): CockpitSnapshot {
  return { plugin, title, checkedAt: new Date().toISOString(), kpis: [], health: [], waiting: [], activity: [], quality: [] };
}

/** Worst status among checks (ok when none). */
export function worstHealth(checks: HealthCheck[]): HealthStatus {
  if (checks.some((c) => c.status === "bad")) return "bad";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}

/** Standard health check for the kit outbox: stuck (pending > 1h) and failed rows. */
export async function outboxHealth(ctx: PluginContext, companyId: string): Promise<HealthCheck> {
  const ns = ctx.db.namespace;
  try {
    const rows = await ctx.db.query<{ stuck: string; failed: string; oldest: string | null }>(
      `SELECT count(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '1 hour')::text AS stuck,
              count(*) FILTER (WHERE status = 'failed')::text AS failed,
              min(created_at) FILTER (WHERE status = 'pending' AND created_at < now() - interval '1 hour')::text AS oldest
         FROM ${ns}.outbox WHERE company_id = $1`,
      [companyId],
    );
    const stuck = Number(rows[0]?.stuck ?? 0);
    const failed = Number(rows[0]?.failed ?? 0);
    if (failed > 0) return { key: "outbox", title: "Cross-plugin deliveries", status: "bad", detail: `${failed} delivery(ies) failed permanently${stuck ? `, ${stuck} waiting over an hour` : ""}.`, fix: "Open the plugin page and retry the failed items (or check the receiving plugin is installed and on).", since: rows[0]?.oldest ?? null };
    if (stuck > 0) return { key: "outbox", title: "Cross-plugin deliveries", status: "warn", detail: `${stuck} delivery(ies) waiting over an hour for an answer.`, fix: "Check the receiving plugin (Mailbox, Accounting…) is ready and switched on.", since: rows[0]?.oldest ?? null };
    return { key: "outbox", title: "Cross-plugin deliveries", status: "ok" };
  } catch {
    return { key: "outbox", title: "Cross-plugin deliveries", status: "ok", detail: "No outbox in this plugin." };
  }
}

// ---------------------------------------------------------------------------
// Job run tracking (for health checks)
// ---------------------------------------------------------------------------

const JOB_STATE = (jobKey: string) => ({ scopeKind: "instance" as const, namespace: "pib-cockpit-jobs", stateKey: `job:${jobKey}` });

export interface JobRunRecord {
  lastStartedAt: string | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}

/** Wrap a job body so its last success/failure is recorded for `jobHealth`. Rethrows errors. */
export async function trackJob<T>(ctx: PluginContext, jobKey: string, run: () => Promise<T>): Promise<T> {
  const started = new Date().toISOString();
  let prev: JobRunRecord = { lastStartedAt: null, lastOkAt: null, lastErrorAt: null, lastError: null, consecutiveFailures: 0 };
  try {
    prev = ((await ctx.state.get(JOB_STATE(jobKey))) as JobRunRecord | null) ?? prev;
  } catch {
    // state unavailable: tracking is best effort
  }
  try {
    const result = await run();
    await ctx.state.set(JOB_STATE(jobKey), { ...prev, lastStartedAt: started, lastOkAt: new Date().toISOString(), consecutiveFailures: 0 }).catch(() => undefined);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.state
      .set(JOB_STATE(jobKey), { ...prev, lastStartedAt: started, lastErrorAt: new Date().toISOString(), lastError: message.slice(0, 500), consecutiveFailures: prev.consecutiveFailures + 1 })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Health of a tracked job. `expectedEveryMinutes` is the schedule interval;
 * no success for 3× that (or 2+ consecutive failures) is a warning, 6× is bad.
 */
export async function jobHealth(ctx: PluginContext, jobKey: string, title: string, expectedEveryMinutes: number): Promise<HealthCheck> {
  let rec: JobRunRecord | null = null;
  try {
    rec = (await ctx.state.get(JOB_STATE(jobKey))) as JobRunRecord | null;
  } catch {
    rec = null;
  }
  const key = `job:${jobKey}`;
  if (!rec || (!rec.lastOkAt && !rec.lastErrorAt)) return { key, title, status: "ok", detail: "Has not run yet." };
  const sinceOkMin = rec.lastOkAt ? (Date.now() - Date.parse(rec.lastOkAt)) / 60_000 : Number.POSITIVE_INFINITY;
  const detail = rec.lastError ? `Last error: ${rec.lastError}` : null;
  if (rec.consecutiveFailures >= 3 || sinceOkMin > expectedEveryMinutes * 6) {
    return { key, title, status: "bad", detail: detail ?? "No successful run for a long time.", since: rec.lastErrorAt ?? rec.lastOkAt, fix: "Check the plugin is ready (Settings → Plugins) and its settings are saved; the Operator investigates repeated failures." };
  }
  if (rec.consecutiveFailures >= 2 || sinceOkMin > expectedEveryMinutes * 3) {
    return { key, title, status: "warn", detail: detail ?? "Runs are late.", since: rec.lastErrorAt ?? rec.lastOkAt };
  }
  return { key, title, status: "ok" };
}

export async function publishCockpitSnapshot(ctx: PluginContext, companyId: string, snapshot: CockpitSnapshot): Promise<void> {
  try {
    await ctx.events.emit(COCKPIT_EVENTS.snapshot, companyId, snapshot as unknown as Record<string, unknown>);
  } catch (error) {
    ctx.logger.info("Cockpit snapshot emit failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

// ---------------------------------------------------------------------------
// Team roles: Operator and Reviewer
// ---------------------------------------------------------------------------

export interface RolesPayload {
  companyId: string;
  operatorAgentId: string | null;
  reviewerAgentId: string | null;
  /** Board user who receives the daily brief and approvals by default. */
  ownerUserId: string | null;
  /** Review outward-facing work (posts, campaigns, invoices, emails) before the person approves. */
  reviewOutward: boolean;
  /** Paperclip status of the role's agent when the Cockpit last checked (`active`, `idle`, `paused`, …). */
  operatorStatus?: string | null;
  reviewerStatus?: string | null;
  /** Every staffed PiB role (from the plugins' snapshots), so any plugin can route work to the right agent. */
  team?: Partial<Record<TeamRoleKey, { agentId: string | null; status?: string | null }>>;
  updatedAt: string;
}

const ROLES_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-cockpit", stateKey: "roles" });

export function registerRoleWatch(ctx: PluginContext): void {
  ctx.events.on(`plugin.${COCKPIT_PLUGIN}.${COCKPIT_EVENTS.rolesUpdated}`, async (event: PluginEvent) => {
    const payload = event.payload as RolesPayload | undefined;
    const companyId = payload?.companyId ?? event.companyId;
    if (!companyId || !payload) return;
    try {
      const current = (await ctx.state.get(ROLES_STATE(companyId))) as RolesPayload | null;
      if (current?.updatedAt && payload.updatedAt && current.updatedAt > payload.updatedAt) return;
      await ctx.state.set(ROLES_STATE(companyId), payload);
    } catch (error) {
      ctx.logger.info("Roles update failed", { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export async function companyRoles(ctx: PluginContext, companyId: string): Promise<RolesPayload | null> {
  try {
    return ((await ctx.state.get(ROLES_STATE(companyId))) as RolesPayload | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * The Reviewer agent to route an outward-facing approval issue to first, or
 * null (then the issue goes straight to the person, as before). The Reviewer
 * checks the work against the playbook/brand rules and hands the issue to
 * the person with a short verdict; it never approves money or sends itself.
 */
export async function reviewerAgentId(ctx: PluginContext, companyId: string): Promise<string | null> {
  const roles = await companyRoles(ctx, companyId);
  if (!roles?.reviewOutward || !roles.reviewerAgentId) return null;
  // A paused, failing or removed Reviewer would hold approvals forever: go straight to the person.
  return roleAgentUsable(roles.reviewerStatus) ? roles.reviewerAgentId : null;
}

/** The Operator agent (to route stuck or unowned work to), or null when there is none or it is not running. */
export async function operatorAgentId(ctx: PluginContext, companyId: string): Promise<string | null> {
  const roles = await companyRoles(ctx, companyId);
  return roles?.operatorAgentId && roleAgentUsable(roles.operatorStatus) ? roles.operatorAgentId : null;
}

/** The running agent in a team role, or null (Operator and Reviewer come from the Cockpit's own roles). */
export async function teamAgentId(ctx: PluginContext, companyId: string, role: TeamRoleKey): Promise<string | null> {
  const roles = await companyRoles(ctx, companyId);
  if (!roles) return null;
  if (role === "operator") return roles.operatorAgentId && roleAgentUsable(roles.operatorStatus) ? roles.operatorAgentId : null;
  if (role === "reviewer") return roles.reviewerAgentId && roleAgentUsable(roles.reviewerStatus) ? roles.reviewerAgentId : null;
  const member = roles.team?.[role];
  return member?.agentId && roleAgentUsable(member.status) ? member.agentId : null;
}

export interface WorkRoute {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  /** Who it went to: a role, the owner (a person), or nobody. */
  via: TeamRoleKey | "owner" | "none";
}

/**
 * Who gets a piece of work: the first running agent among `roles` (in
 * order), else the Operator, else the company owner, else nobody. Use it for
 * every issue a plugin opens so nothing is left unassigned.
 */
export async function routeWork(ctx: PluginContext, companyId: string, roles: TeamRoleKey[]): Promise<WorkRoute> {
  for (const role of [...roles, "operator" as const]) {
    const agentId = await teamAgentId(ctx, companyId, role);
    if (agentId) return { assigneeAgentId: agentId, assigneeUserId: null, via: role };
  }
  const owner = (await companyRoles(ctx, companyId))?.ownerUserId ?? null;
  return owner ? { assigneeAgentId: null, assigneeUserId: owner, via: "owner" } : { assigneeAgentId: null, assigneeUserId: null, via: "none" };
}

/** Unknown status counts as usable (older Cockpits did not send it). */
export function roleAgentUsable(status: string | null | undefined): boolean {
  return !status || teamRoleHealth({ agentStatus: status, hireOpen: false }) === "ok";
}

/** Text appended to an approval issue routed to the Reviewer. */
export function reviewerBrief(input: { what: string; checks: string[]; handTo: { userId?: string | null; label: string } }): string {
  return [
    "",
    "## Reviewer: check before the person approves",
    `You are reviewing: ${input.what}.`,
    "Check:",
    ...input.checks.map((c) => `- ${c}`),
    "",
    `Then comment **PASS** or **CHANGES NEEDED** with one line per problem, and reassign this issue to ${input.handTo.label}. Do not approve, send or mark it done yourself.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Hand-offs between plugins
// ---------------------------------------------------------------------------

export const HANDOFF_EVENTS = {
  /** SEO → Social: a page/post went live; Social opens a repurpose task. */
  contentPublished: "content.published",
  /** Social / Mailbox → CRM: someone showed buying intent; CRM creates or updates the lead. */
  leadCaptured: "lead.captured",
  /** CRM → the sender: the lead was stored or held, so the sender stops re-emitting it. */
  leadCapturedResult: "lead.captured.result",
  /** CRM → Billing and the Cockpit: a deal was won. Billing opens the drafting task; the Cockpit starts onboarding on a first win. */
  dealWon: "deal.won",
  /** Billing → CRM: the customer accepted a quote. The CRM moves its deal to won. */
  quoteAccepted: "quote.accepted",
  /** Billing → CRM and the Cockpit: an invoice is paid in full. */
  invoicePaid: "invoice.paid",
  /** CRM / Campaigns / Mailbox → each other: stop marketing email to an address (every email after a hard bounce). */
  contactSuppressed: "contact.suppressed",
} as const;

/** Plugins that send `lead.captured` (the CRM listens to each). */
export const LEAD_SOURCES: string[] = [PIB_PLUGINS.social, PIB_PLUGINS.mailbox];

/** Plugins that send `contact.suppressed` (each listens to the others). */
export const SUPPRESSION_SOURCES: string[] = [PIB_PLUGINS.crm, PIB_PLUGINS.campaigns, PIB_PLUGINS.mailbox];

export interface ContentPublished {
  key: string; // `seo:content:<id>`
  url: string;
  title: string;
  summary?: string | null;
  keyword?: string | null;
  clientKind?: ClientKind | null;
  clientRef?: string | null;
  publishedAt: string;
}

export interface LeadCaptured {
  key: string; // `social:inbox:<itemId>` / `mail:<messageId>`
  source: "social" | "email" | "form" | "other";
  name?: string | null;
  email?: string | null;
  handle?: string | null;
  platform?: string | null;
  text: string;
  url?: string | null;
  /** Scope of the work that produced the lead (own work or a client). */
  clientKind?: ClientKind | null;
  clientRef?: string | null;
  confidence?: number | null;
  capturedAt: string;
}

export interface LeadCapturedResult {
  /** The `LeadCaptured` key. */
  key: string;
  /** `stored`: in the CRM; `held`: kept until the CRM is ready (off or settings unsaved); `ignored`: not a lead (duplicate, own address). */
  status: "stored" | "held" | "ignored";
  contactId?: string | null;
  reason?: string | null;
}

export interface DealWon {
  key: string; // `crm:deal:<id>:won`
  dealId: string;
  title: string;
  valueMinor: number | null;
  currency: string;
  clientKind: ClientKind;
  clientRef: string;
  clientName: string;
  contactEmail?: string | null;
  /** The client's first won deal: it has just become a customer, so onboarding starts. */
  firstWin: boolean;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  wonAt: string;
}

export interface QuoteAccepted {
  key: string; // `billing:quote:<id>:accepted`
  quoteId: string;
  number: string;
  dealId?: string | null;
  clientKind: ClientKind | null;
  clientRef: string | null;
  totalMinor: number;
  currency: string;
  acceptedAt: string;
}

export interface InvoicePaid {
  key: string; // `billing:invoice:<id>:paid`
  invoiceId: string;
  number: string;
  dealId?: string | null;
  clientKind: ClientKind | null;
  clientRef: string | null;
  totalMinor: number;
  currency: string;
  paidAt: string;
}

export type SuppressionReason = "unsubscribed" | "bounced" | "complained" | "manual";

export interface ContactSuppressed {
  key: string; // `suppress:<email>:<reason>`
  email: string;
  reason: SuppressionReason;
  /** `marketing` stops campaigns and sequences only; `all` (hard bounce) stops every email. */
  scope: "marketing" | "all";
  /** The plugin that saw it. */
  source: string;
  clientKind?: ClientKind | null;
  clientRef?: string | null;
  at: string;
}

/** Unsubscribes and complaints stop marketing email; a hard bounce stops everything. */
export function suppressionScope(reason: SuppressionReason): "marketing" | "all" {
  return reason === "bounced" ? "all" : "marketing";
}

/** Normalised address for suppression lists (trimmed, lower case). */
export function suppressionEmail(email: string): string {
  return email.trim().toLowerCase();
}
