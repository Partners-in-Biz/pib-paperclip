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
import { routineHealth } from "./routine-health.js";
import { teamRoleChain, teamRoleHealth, type TeamRoleKey } from "./team.js";
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

/**
 * The snapshot with a health check for every managed routine of this plugin
 * whose latest firing created no work (kit `routineHealth`). Plugins that
 * build their own live snapshot can wrap it too, so the page shows the same.
 * Never throws; a check the plugin already reports itself is kept as is.
 */
export async function withRoutineHealth(ctx: PluginContext, companyId: string, snapshot: CockpitSnapshot): Promise<CockpitSnapshot> {
  try {
    const checks = (await routineHealth(ctx, companyId)).filter((check) => !snapshot.health.some((own) => own.key === check.key));
    return checks.length ? { ...snapshot, health: [...snapshot.health, ...checks] } : snapshot;
  } catch {
    return snapshot;
  }
}

export async function publishCockpitSnapshot(ctx: PluginContext, companyId: string, snapshot: CockpitSnapshot): Promise<void> {
  try {
    await ctx.events.emit(COCKPIT_EVENTS.snapshot, companyId, (await withRoutineHealth(ctx, companyId, snapshot)) as unknown as Record<string, unknown>);
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
  /** Set by `registerRoleWatch` when a plugin stores its copy: when this copy last arrived (the Cockpit does not send it). */
  receivedAt?: string;
}

const ROLES_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-cockpit", stateKey: "roles" });
const OWNER_LAST_KNOWN_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-kit", stateKey: "owner-last-known" });

/** A moment as epoch ms from an ISO stamp or the host's Postgres text ("2026-09-27 18:46:11.052+00"); NaN when unreadable. */
export function stampMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/**
 * True when `incoming` is strictly older than the copy a plugin holds. Stamps
 * are compared as moments, never as text: the first broadcast carried an ISO
 * stamp ("2026-09-27T06:32:49.178Z") and every later one the host's Postgres
 * text ("2026-09-27 18:46:11.052+00"), and "T" sorts after " ", so a text
 * compare dropped every later broadcast and froze each plugin's copy on the
 * first one (no owner, no Reviewer) for five days (Q5-6). An unreadable stamp
 * never blocks an update.
 */
export function rolesPayloadIsOlder(current: Pick<RolesPayload, "updatedAt"> | null | undefined, incoming: Pick<RolesPayload, "updatedAt">): boolean {
  const have = stampMs(current?.updatedAt);
  const next = stampMs(incoming.updatedAt);
  return Number.isFinite(have) && Number.isFinite(next) && have > next;
}

/** The host's board sentinel (a local_trusted install): not a company member, so nothing can be assigned to it. */
export const LOCAL_BOARD_USER_ID = "local-board";

/** The id when issues can be assigned to it, else null (empty, or the board sentinel). */
export function assignableUserId(userId: string | null | undefined): string | null {
  return typeof userId === "string" && userId.trim() && userId.trim() !== LOCAL_BOARD_USER_ID ? userId.trim() : null;
}

export function registerRoleWatch(ctx: PluginContext): void {
  ctx.events.on(`plugin.${COCKPIT_PLUGIN}.${COCKPIT_EVENTS.rolesUpdated}`, async (event: PluginEvent) => {
    const payload = event.payload as RolesPayload | undefined;
    const companyId = payload?.companyId ?? event.companyId;
    if (!companyId || !payload) return;
    try {
      const current = (await ctx.state.get(ROLES_STATE(companyId))) as RolesPayload | null;
      if (rolesPayloadIsOlder(current, payload)) return;
      await ctx.state.set(ROLES_STATE(companyId), { ...payload, receivedAt: new Date().toISOString() });
      // The last owner ever seen survives a later copy that has none, so a cleared owner never leaves approvals unassigned.
      const owner = assignableUserId(payload.ownerUserId);
      if (owner) await ctx.state.set(OWNER_LAST_KNOWN_STATE(companyId), { userId: owner, at: new Date().toISOString() });
    } catch (error) {
      ctx.logger.info("Roles update failed", { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export interface RolesRead {
  roles: RolesPayload | null;
  /** The state read threw (the host refused the call, or the state store failed); `roles` is null then. */
  error: string | null;
  /** How long ago this plugin's copy arrived, when it says (copies stored before kit 0.2 do not). */
  ageMs: number | null;
}

let rolesErrorLoggedAt = 0;

/**
 * The company's roles as this plugin holds them, with what went wrong when
 * there are none. `companyRoles` returns only the payload; use this where a
 * missing copy must be visible instead of silently meaning "no Reviewer, no
 * owner". A failed read is logged (at most once a minute per worker).
 */
export async function readCompanyRoles(ctx: PluginContext, companyId: string, now: number = Date.now()): Promise<RolesRead> {
  try {
    const roles = ((await ctx.state.get(ROLES_STATE(companyId))) as RolesPayload | null) ?? null;
    const received = stampMs(roles?.receivedAt);
    return { roles, error: null, ageMs: Number.isFinite(received) ? Math.max(0, now - received) : null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (now - rolesErrorLoggedAt > 60_000) {
      rolesErrorLoggedAt = now;
      ctx.logger?.warn?.("Roles copy could not be read; routing falls back to the company's default owner", { companyId, error: message });
    }
    return { roles: null, error: message, ageMs: null };
  }
}

/**
 * The company's roles for routing. This is the stored copy, with one repair:
 * when the copy has no owner (or there is no copy at all) and the host knows the
 * company's default responsible user, that person is the owner. Every existing
 * caller that reads `.ownerUserId` (approvals, work routing, leave, mail) is
 * therefore protected from a frozen, missing or ownerless copy without changing
 * its code. Use `readCompanyRoles` for the raw copy and how old it is.
 */
export async function companyRoles(ctx: PluginContext, companyId: string): Promise<RolesPayload | null> {
  const { roles } = await readCompanyRoles(ctx, companyId);
  if (assignableUserId(roles?.ownerUserId)) return roles;
  const owner = await companyDefaultOwner(ctx, companyId);
  if (!owner) return roles;
  return roles
    ? { ...roles, ownerUserId: owner }
    : { companyId, operatorAgentId: null, reviewerAgentId: null, ownerUserId: owner, reviewOutward: false, updatedAt: "" };
}

/** The last owner this plugin ever saw in a roles broadcast, or null. */
export async function lastKnownOwner(ctx: PluginContext, companyId: string): Promise<string | null> {
  try {
    const value = (await ctx.state.get(OWNER_LAST_KNOWN_STATE(companyId))) as { userId?: unknown } | null;
    return assignableUserId(typeof value?.userId === "string" ? value.userId : null);
  } catch {
    return null;
  }
}

/** One short-lived memo per plugin context (one per worker in production), so tests and workers never share it. */
const defaultOwnerCache = new WeakMap<object, Map<string, { userId: string | null; at: number }>>();
const DEFAULT_OWNER_TTL_MS = 5 * 60_000;

/**
 * The company's default responsible person as the host keeps it
 * (`Company.defaultResponsibleUserId`, set when the company is created). It
 * does not depend on the Cockpit's roles broadcast, so it exists for a
 * company that never saved its team (Partners in Apps has no roles at all).
 * Needs the `companies.read` capability (every PiB plugin declares it);
 * null when it is missing, the company is unknown or the call fails. An answer
 * is cached for five minutes; a failed or empty lookup is not.
 */
export async function companyDefaultOwner(ctx: PluginContext, companyId: string, now: number = Date.now()): Promise<string | null> {
  let memo = defaultOwnerCache.get(ctx);
  if (!memo) {
    memo = new Map();
    defaultOwnerCache.set(ctx, memo);
  }
  const cached = memo.get(companyId);
  if (cached && now - cached.at < DEFAULT_OWNER_TTL_MS) return cached.userId;
  let userId: string | null = null;
  try {
    const company = (await ctx.companies.get(companyId)) as { defaultResponsibleUserId?: string | null } | null;
    userId = assignableUserId(company?.defaultResponsibleUserId ?? null);
    // Only an answer is cached. A refused call (a job for a company with no saved config) or an unknown company is not: a tool call seconds later may succeed.
    if (company) memo.set(companyId, { userId, at: now });
  } catch {
    userId = null;
  }
  return userId;
}

/** Clears the default-owner memo for one company, or for all of them. */
export function forgetCompanyDefaultOwner(ctx: PluginContext, companyId?: string): void {
  if (!companyId) defaultOwnerCache.delete(ctx);
  else defaultOwnerCache.get(ctx)?.delete(companyId);
}

export type OwnerSource = "roles" | "company-default" | "actor" | "last-known";

/**
 * The person who decides things for the company, from the first source that
 * has one: the Cockpit's roles copy, the host's default responsible user, the
 * person who triggered this work (`actorUserId`), and, only when
 * `lastKnown` is set, the last owner this plugin ever saw. Nothing here depends
 * on the roles copy being fresh, so an approval finds a person for as long as
 * the company has one. Approvals set `lastKnown` (an unassigned approval is
 * never right); plain work routing does not, so an owner someone cleared on
 * purpose stays cleared.
 */
export async function ownerUserFor(
  ctx: PluginContext,
  companyId: string,
  options: { roles?: RolesPayload | null; actorUserId?: string | null; lastKnown?: boolean } = {},
): Promise<{ userId: string | null; source: OwnerSource | null }> {
  const roles = options.roles !== undefined ? options.roles : (await readCompanyRoles(ctx, companyId)).roles;
  const fromRoles = assignableUserId(roles?.ownerUserId);
  if (fromRoles) return { userId: fromRoles, source: "roles" };
  const fromCompany = await companyDefaultOwner(ctx, companyId);
  if (fromCompany) return { userId: fromCompany, source: "company-default" };
  const actor = assignableUserId(options.actorUserId);
  if (actor) return { userId: actor, source: "actor" };
  const remembered = options.lastKnown ? await lastKnownOwner(ctx, companyId) : null;
  return remembered ? { userId: remembered, source: "last-known" } : { userId: null, source: null };
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
 * order), else the Operator, else the company owner (`ownerUserFor`: the
 * roles copy, then the host's default responsible user), else nobody. Use it
 * for every issue a plugin opens so nothing is left unassigned.
 */
export async function routeWork(ctx: PluginContext, companyId: string, roles: TeamRoleKey[]): Promise<WorkRoute> {
  for (const role of [...roles, "operator" as const]) {
    const agentId = await teamAgentId(ctx, companyId, role);
    if (agentId) return { assigneeAgentId: agentId, assigneeUserId: null, via: role };
  }
  const owner = (await ownerUserFor(ctx, companyId)).userId;
  return owner ? { assigneeAgentId: null, assigneeUserId: owner, via: "owner" } : { assigneeAgentId: null, assigneeUserId: null, via: "none" };
}

/** Work for one role: that role, then the roles covering it (kit `teamRoleChain`), then the Operator, then the owner. */
export async function routeRole(ctx: PluginContext, companyId: string, role: TeamRoleKey): Promise<WorkRoute> {
  return routeWork(ctx, companyId, teamRoleChain(role));
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
  /** CRM → every plugin that holds personal data: erase one approved person (kit `privacy.ts`). */
  contactEraseRequested: "contact.erase.requested",
  /** Each of those plugins → CRM: what it erased and what the law makes it keep. */
  contactEraseCompleted: "contact.erase.completed",
  /** CRM / Mailbox / Campaigns / Social → each other: consent given, withdrawn or a lawful basis noted. */
  consentRecorded: "consent.recorded",
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
  /**
   * Whose list the opt-out is on: `own` (PiB's own marketing) or `company:<id>` /
   * `contact:<id>` (a client's). An unsubscribe from one sender never silences
   * another; a hard bounce (`scope: "all"`) ignores it. Absent on rows from before
   * kit 0.2: those stay company-wide, as they were (see `sender-scope.ts`).
   */
  senderKey?: string | null;
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
