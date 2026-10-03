/**
 * The Operator's view of the company (worker side): the same merge the page
 * does, from the projection plus host records the worker can read. Backs the
 * agent tools.
 */
import type { PluginContext, ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, TEAM_ROLES, toolFail, toolOk, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import { formatAmount } from "./activity.js";
import { askWaitingItem, type AskView } from "./ask-model.js";
import { openAskViews } from "./asks.js";
import { assignableUser, ORIGIN } from "./constants.js";
import { getBriefIssue, getRoles, listSnapshots, saveBriefIssue } from "./db.js";
import { message, type Env } from "./env.js";
import { buildFlows, type FlowStageView } from "./flows.js";
import { collectProblems, expectedPlugins, linkFor, listAgents, storedSnapshots } from "./health.js";
import {
  activityGroups,
  agentRows,
  groupKpis,
  healthGroups,
  hostWaiting,
  mergeWaiting,
  setupMissingCount,
  shownIssueIds,
  staleChecks,
  todayLine,
  unassignedWaiting,
  worstOf,
  type AgentLite,
  type ApprovalLite,
  type CockpitSnapshot,
  type IssueLite,
  type RunStat,
  type WaitingEntry,
} from "./merge.js";
import { ownSnapshot } from "./own.js";
import { currentRoles } from "./roles.js";
import { TOOL_NAMES } from "./tools.js";

/** ISO time from a Date or a core-read text timestamp (`2026-09-25 17:09:53.8+02`: Safari cannot parse that form). */
const iso = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value.includes("T") ? value : value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isFinite(t) ? new Date(t).toISOString() : value;
};

export async function listApprovals(ctx: PluginContext, companyId: string): Promise<ApprovalLite[]> {
  try {
    const rows = await ctx.approvals.list({ companyId });
    return (rows as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      type: String(row.type ?? ""),
      status: String(row.status ?? ""),
      payload: row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : null,
      createdAt: iso(row.createdAt),
    }));
  } catch (error) {
    ctx.logger.info("Cockpit approvals read failed", { companyId, error: message(error) });
    return [];
  }
}

/** Open issues assigned to a person (core read of public.issues). */
export async function listUserIssues(ctx: PluginContext, companyId: string, userId: string | null): Promise<IssueLite[]> {
  if (!userId) return [];
  try {
    const rows = await ctx.db.query<Record<string, unknown>>(
      `SELECT id, identifier, title, status, priority, updated_at, created_at FROM public.issues
        WHERE company_id = $1 AND assignee_user_id = $2 AND hidden_at IS NULL AND status IN ('todo', 'in_progress', 'in_review', 'blocked')
        ORDER BY updated_at DESC LIMIT 50`,
      [companyId, userId],
    );
    return rows.map((row) => ({
      id: String(row.id),
      identifier: row.identifier == null ? null : String(row.identifier),
      title: String(row.title ?? ""),
      status: String(row.status ?? ""),
      priority: row.priority == null ? null : String(row.priority),
      updatedAt: iso(row.updated_at),
      createdAt: iso(row.created_at),
    }));
  } catch (error) {
    ctx.logger.info("Cockpit issue read failed", { companyId, error: message(error) });
    return [];
  }
}

export interface UnassignedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string | null;
  createdAt: string | null;
}

/**
 * Open issues with no agent and no person assigned, created more than a day
 * ago: the count and the first 50 (most urgent, then oldest). The page and the
 * brief leave out the ones listed on their own row and show five.
 */
export async function listUnassigned(ctx: PluginContext, companyId: string): Promise<{ count: number; items: UnassignedIssue[] }> {
  const where = `company_id = $1 AND assignee_agent_id IS NULL AND assignee_user_id IS NULL AND hidden_at IS NULL
        AND status IN ('todo', 'in_progress', 'in_review', 'blocked') AND created_at < now() - interval '1 day'`;
  try {
    const [count, rows] = await Promise.all([
      ctx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM public.issues WHERE ${where}`, [companyId]),
      ctx.db.query<Record<string, unknown>>(
        `SELECT id, identifier, title, status, priority, created_at FROM public.issues WHERE ${where}
          ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at LIMIT 50`,
        [companyId],
      ),
    ]);
    return {
      count: Number(count[0]?.n ?? rows.length) || 0,
      items: rows.map((row) => ({
        id: String(row.id),
        identifier: row.identifier == null ? null : String(row.identifier),
        title: String(row.title ?? ""),
        status: String(row.status ?? ""),
        priority: row.priority == null ? null : String(row.priority),
        createdAt: iso(row.created_at),
      })),
    };
  } catch (error) {
    ctx.logger.info("Cockpit unassigned read failed", { companyId, error: message(error) });
    return { count: 0, items: [] };
  }
}

/**
 * Heartbeat runs counted per agent and status (core read of
 * public.heartbeat_runs), by the database: one `GROUP BY agent_id, status`
 * row per pair, never a row fetch. The old `LIMIT 1000` cut a busy company's
 * 1,400 runs a week short, which understated every failure view. The counts
 * cover the last 7 days, the activity window and the last 24 hours; the latest
 * start and run id per status are read over the last `days` days.
 */
export async function listRuns(ctx: PluginContext, companyId: string, input: { now: Date; days: number; windowHours: number }): Promise<RunStat[]> {
  const ago = (ms: number) => new Date(input.now.getTime() - ms).toISOString();
  try {
    const rows = await ctx.db.query<Record<string, unknown>>(
      `SELECT agent_id, status,
              count(*) FILTER (WHERE started_at >= $3::timestamptz)::text AS week,
              count(*) FILTER (WHERE started_at >= $4::timestamptz)::text AS win,
              count(*) FILTER (WHERE started_at >= $5::timestamptz)::text AS day,
              max(started_at) AS last_started_at,
              (array_agg(id ORDER BY started_at DESC))[1]::text AS last_id
         FROM public.heartbeat_runs
        WHERE company_id = $1 AND started_at >= $2::timestamptz
        GROUP BY agent_id, status`,
      [companyId, ago(input.days * 86_400_000), ago(7 * 86_400_000), ago(input.windowHours * 3_600_000), ago(86_400_000)],
    );
    return rows.map((row) => ({
      agentId: String(row.agent_id),
      status: String(row.status ?? ""),
      week: Number(row.week) || 0,
      window: Number(row.win) || 0,
      day: Number(row.day) || 0,
      lastStartedAt: iso(row.last_started_at),
      lastRunId: row.last_id == null ? null : String(row.last_id),
    }));
  } catch (error) {
    ctx.logger.info("Cockpit run read failed", { companyId, error: message(error) });
    return [];
  }
}

async function setupStatuses(env: Env, companyId: string): Promise<Record<string, SetupStatus>> {
  const out: Record<string, SetupStatus> = {};
  for (const row of await listSnapshots(env.ctx, companyId, "setup")) {
    const status = row.payload as SetupStatus | null;
    if (status && Array.isArray(status.items)) out[row.pluginKey] = status;
  }
  return out;
}

async function enabledModules(env: Env, companyId: string, keys: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const key of keys) out[key] = await isModuleEnabled(env.ctx, companyId, key);
  return out;
}

export interface CompanyData {
  snapshots: CockpitSnapshot[];
  receivedAt: Record<string, string>;
  agents: AgentLite[];
  /** Runs counted by the database (`listRuns`). */
  runStats: RunStat[];
  approvals: ApprovalLite[];
  ownerIssues: IssueLite[];
  setupMissing: number;
  /** The open Finish setup issue (from the Setup plugin's count), listed once as the setup item. */
  setupIssueId?: string | null;
  ownerUserId: string | null;
  listeningSince: string | null;
  /** Questions agents asked the owner that wait for a reply. */
  asks: AskView[];
  /** Open issues nobody is assigned to (older than a day). */
  unassigned: { count: number; items: UnassignedIssue[] };
}

export async function loadCompanyData(env: Env, companyId: string, days = 7, windowHours = days * 24): Promise<CompanyData> {
  const roles = await getRoles(env.ctx, companyId);
  const stored = await storedSnapshots(env, companyId);
  const own = await ownSnapshot(env, companyId);
  const [agents, runStats, approvals, ownerIssues, statuses, asks, unassigned] = await Promise.all([
    listAgents(env, companyId),
    listRuns(env.ctx, companyId, { now: env.now(), days: Math.max(days, 7), windowHours }),
    listApprovals(env.ctx, companyId),
    listUserIssues(env.ctx, companyId, roles?.ownerUserId ?? null),
    setupStatuses(env, companyId),
    openAskViews(env, companyId).catch((error) => {
      env.ctx.logger.info("Cockpit asks read failed", { companyId, error: message(error) });
      return [] as AskView[];
    }),
    listUnassigned(env.ctx, companyId),
  ]);
  const enabled = await enabledModules(env, companyId, Object.keys(statuses));
  // The Setup plugin's own count (the number the Setup page shows) when it has sent one; else the same kit count over what the Cockpit stored.
  const setup = await readSetupSummary(env, companyId);
  const missing = setup ? setup.requiredLeft : setupMissingCount(Object.fromEntries(Object.entries(statuses).filter(([key]) => enabled[key])), null);
  return {
    snapshots: [...stored.map((s) => s.snapshot), own],
    receivedAt: Object.fromEntries(stored.map((s) => [s.snapshot.plugin, s.receivedAt])),
    agents,
    runStats,
    approvals,
    ownerIssues,
    setupMissing: missing,
    setupIssueId: setup?.finishIssueId ?? null,
    ownerUserId: roles?.ownerUserId ?? null,
    listeningSince: roles?.createdAt ?? null,
    asks,
    unassigned,
  };
}

/** Everything waiting: questions for the owner first, then each plugin's items, unassigned work and the host's approvals and issues; each issue once. */
export function waitingFrom(data: Pick<CompanyData, "snapshots" | "approvals" | "ownerIssues" | "setupMissing"> & Partial<Pick<CompanyData, "asks" | "unassigned" | "setupIssueId">>): WaitingEntry[] {
  const own = [
    { source: "asks", sourceTitle: "Asked by agents", items: (data.asks ?? []).map(askWaitingItem) },
    ...data.snapshots.map((snapshot) => ({ source: snapshot.plugin, sourceTitle: snapshot.title, items: snapshot.waiting })),
  ];
  const host = { source: "host", sourceTitle: "Paperclip", items: hostWaiting({ approvals: data.approvals, myIssues: data.ownerIssues, setupMissing: data.setupMissing, setupIssueId: data.setupIssueId }) };
  return mergeWaiting([...own, { source: "unassigned", sourceTitle: "Paperclip", items: unassignedWaiting(data.unassigned, shownIssueIds([...own, host])) }, host]);
}

// ---------------------------------------------------------------------------
// The Setup plugin's count (event `plugin.partnersinbiz.setup.setup.summary`)
// ---------------------------------------------------------------------------

/** What the Setup plugin sends: its one setup count and the open Finish setup issue. */
export interface SetupSummaryCopy {
  requiredLeft: number;
  requiredDone: number;
  requiredTotal: number;
  optionalLeft: number;
  finishIssueId: string | null;
  updatedAt: string;
}

const SETUP_SUMMARY_STATE = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "cockpit", stateKey: "setup-summary" });

export function parseSetupSummary(payload: unknown): SetupSummaryCopy | null {
  const row = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);
  if (!row || n(row.requiredLeft) === null) return null;
  return {
    requiredLeft: n(row.requiredLeft)!,
    requiredDone: n(row.requiredDone) ?? 0,
    requiredTotal: n(row.requiredTotal) ?? n(row.requiredLeft)!,
    optionalLeft: n(row.optionalLeft) ?? 0,
    finishIssueId: typeof row.finishIssueId === "string" && row.finishIssueId ? row.finishIssueId : null,
    updatedAt: typeof row.updatedAt === "string" && !Number.isNaN(Date.parse(row.updatedAt)) ? row.updatedAt : new Date(0).toISOString(),
  };
}

/** Keep the newest count the Setup plugin sent for a company. */
export async function onSetupSummary(env: Env, companyId: string | null | undefined, payload: unknown): Promise<boolean> {
  const summary = parseSetupSummary(payload);
  if (!companyId || !summary) return false;
  const current = await readSetupSummary(env, companyId);
  if (current && current.updatedAt > summary.updatedAt) return false;
  await env.ctx.state.set(SETUP_SUMMARY_STATE(companyId), summary);
  return true;
}

export async function readSetupSummary(env: Env, companyId: string): Promise<SetupSummaryCopy | null> {
  try {
    return parseSetupSummary(await env.ctx.state.get(SETUP_SUMMARY_STATE(companyId)));
  } catch {
    return null;
  }
}

function pct(ratio: number | null): number | null {
  return ratio === null ? null : Math.round(ratio * 100);
}

/** How many stuck stages the brief lists (worst first). */
export const BRIEF_STUCK_STAGES = 5;

/** One stuck stage of the company graph, for the Operator (the same numbers as Cockpit → Flows). */
export function stuckFlowItem(stage: FlowStageView, link: (href: string) => string | null) {
  return {
    flow: stage.flowTitle,
    stage: stage.label,
    stuck: stage.stuck,
    of: stage.count,
    why: stage.stuckReason,
    waitsOn: stage.waitingOn,
    ...(stage.waits.kind === "agent" ? { agent: stage.waits.label } : {}),
    ...(stage.amountMinor !== null ? { amount: formatAmount(stage.amountMinor, stage.currency ?? "ZAR") } : {}),
    ...(stage.oldestDays !== null ? { oldestDays: stage.oldestDays } : {}),
    href: link(stage.href),
  };
}

/** Compact JSON for the Operator: waiting, health, KPIs, activity, agents incl. spend/budget. */
export async function companyBrief(env: Env, companyId: string, options: { windowHours?: number } = {}) {
  const windowHours = Math.min(Math.max(Math.round(options.windowHours ?? 24), 1), 720);
  const data = await loadCompanyData(env, companyId, Math.ceil(windowHours / 24), windowHours);
  const now = env.now();
  const company = await env.ctx.companies.get(companyId).catch(() => null);
  const prefix = company?.issuePrefix ?? null;
  const link = (href: string | null | undefined) => (href ? linkFor(href, prefix) : null);

  const expected = await expectedPlugins(env, companyId, Object.keys(data.receivedAt));
  const stale = staleChecks({ expected, lastSnapshot: Object.fromEntries(data.snapshots.map((s) => [s.plugin, s.checkedAt])), now, listeningSince: data.listeningSince });
  const groups = healthGroups(data.snapshots, stale);
  const problems = await collectProblems(env, companyId, { snapshots: data.snapshots, agents: data.agents, listeningSince: data.listeningSince });
  const waiting = waitingFrom(data);
  const agents = agentRows(data.agents, { stats: data.runStats, snapshots: data.snapshots, since: new Date(now.getTime() - 7 * 86_400_000) });
  const activity = activityGroups({ snapshots: data.snapshots, stats: data.runStats, agents: data.agents, now, windowMs: windowHours * 3_600_000, perGroup: 6 });
  const kpis = groupKpis(data.snapshots);
  const health = worstOf(groups.map((g) => g.status));
  const problemCount = problems.entries.filter((e) => e.status === "bad").length;
  const roles = await currentRoles(env, companyId).catch(() => null);
  const names = new Map(data.agents.map((a) => [a.id, a.name]));
  const graph = buildFlows({ snapshots: data.snapshots, roles, agents: data.agents });

  return {
    company: { id: companyId, name: company?.name ?? null, prefix },
    generatedAt: now.toISOString(),
    today: todayLine({
      waiting: waiting.length,
      health,
      problems: problemCount,
      agentAlerts: agents.filter((a) => a.alert).length,
      activeAgents: agents.filter((a) => ["active", "running", "idle"].includes(a.status)).length,
    }),
    waiting: waiting.map((w) => ({
      title: w.title,
      why: w.why,
      kind: w.kind,
      href: link(w.href),
      issueId: w.issueId ?? null,
      since: w.since ?? null,
      from: w.sourceTitle,
      ...(w.ask ? { question: { askKind: w.ask.kind, options: w.ask.options, askedBy: w.ask.askedBy, dueBy: w.ask.dueBy } } : {}),
      ...(w.examples ? { examples: w.examples.map((e) => ({ title: e.title, href: link(e.href), since: e.since ?? null })) } : {}),
    })),
    /** Questions agents asked the owner, oldest first: answered on the issue, they go back to the agent. */
    asks: data.asks.map((a) => ({
      askId: a.id,
      issue: a.identifier ?? a.issueId,
      href: link(`/issues/${a.identifier ?? a.issueId}`),
      kind: a.kind,
      question: a.question,
      options: a.options,
      askedBy: a.askedBy,
      askedAt: a.askedAt,
      ageDays: Math.floor((now.getTime() - Date.parse(a.askedAt)) / 86_400_000),
      dueBy: a.dueBy,
      client: a.clientRef,
    })),
    /** Stuck in the flows: the stages of the company graph where work waits longest (top 5, worst first), with who it waits on. */
    stuckFlows: graph.stuck.slice(0, BRIEF_STUCK_STAGES).map((stage) => stuckFlowItem(stage, link)),
    /** Open issues with nobody assigned (older than a day): route each to the agent that owns the work. */
    unassigned: {
      count: data.unassigned.count,
      items: data.unassigned.items.slice(0, 5).map((i) => ({ issue: i.identifier ?? i.id, title: i.title, status: i.status, priority: i.priority, createdAt: i.createdAt, href: link(`/issues/${i.identifier ?? i.id}`) })),
    },
    /** Who holds each team role (for hand-offs); an unstaffed sales role names who covers it (`coveredBy`). */
    team: Object.fromEntries(
      TEAM_ROLES.map((role) => {
        const member = role.key === "operator"
          ? { agentId: roles?.operatorAgentId ?? null, status: roles?.operatorStatus ?? null }
          : role.key === "reviewer"
            ? { agentId: roles?.reviewerAgentId ?? null, status: roles?.reviewerStatus ?? null }
            : roles?.team?.[role.key] ?? { agentId: null, status: null };
        const coveredBy = role.coveredBy ? TEAM_ROLES.find((r) => r.key === role.coveredBy)?.title ?? null : null;
        return [role.key, { title: role.title, agentId: member.agentId, agent: member.agentId ? names.get(member.agentId) ?? null : null, status: member.status ?? null, ...(coveredBy && !member.agentId ? { coveredBy } : {}) }];
      }),
    ),
    health: {
      status: health,
      problems: groups.flatMap((g) => g.checks.filter((c) => c.status !== "ok").map((c) => ({ plugin: g.title, status: c.status, title: c.title, detail: c.detail ?? null, fix: c.fix ?? null, href: link(c.href), since: c.since ?? null }))),
      agentAlerts: problems.entries.filter((e) => e.plugin === "agents").map((e) => ({ title: e.title, detail: e.detail ?? null, error: e.raw ?? null, href: link(e.href) })),
    },
    kpis: Object.fromEntries(
      Object.entries(kpis)
        .filter(([, list]) => list.length > 0)
        .map(([group, list]) => [group, list.map((k) => ({ label: k.label, value: k.value, tone: k.tone ?? "neutral", delta: k.delta ?? null, href: link(k.href), from: k.pluginTitle }))]),
    ),
    activity: activity.map((g) => ({ agent: g.name, agentId: g.agentId, runs: g.runs, done: g.lines.map((l) => ({ at: l.at, text: l.text, href: link(l.href) })) })),
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      title: a.title ?? null,
      status: a.status,
      lastRunAt: a.lastRunAt ?? null,
      spentCents: a.spentMonthlyCents,
      budgetCents: a.budgetMonthlyCents,
      budgetUsedPct: pct(a.budgetRatio),
      alert: a.alertText,
      // The adapter's own words, for fixing it.
      error: a.alertRaw,
      lastFailedRun: a.lastFailedRunId ? link(`/agents/${a.urlKey || a.id}/runs/${a.lastFailedRunId}`) : null,
      runs7d: a.runs,
      quality: a.quality.map((q) => ({ label: q.label, value: q.value, tone: q.tone ?? "neutral" })),
    })),
    setupMissing: data.setupMissing,
    links: { cockpit: link("/cockpit"), flows: link("/cockpit?tab=flows"), setup: link("/setup") },
  };
}

export type CompanyBrief = Awaited<ReturnType<typeof companyBrief>>;

// ---------------------------------------------------------------------------
// Daily brief issue
// ---------------------------------------------------------------------------

/** ISO week key, e.g. `2026-W39`, in SAST (UTC+2). */
export function weekKey(date: Date): string {
  const sast = new Date(date.getTime() + 2 * 3_600_000);
  const d = new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function mondayLabel(date: Date): string {
  const sast = new Date(date.getTime() + 2 * 3_600_000);
  const day = sast.getUTCDay() || 7;
  const monday = new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate() - day + 1));
  return monday.toISOString().slice(0, 10);
}

/** This week's pinned Daily brief issue (created on first use, assigned to the owner). */
export async function ensureBriefIssue(env: Env, companyId: string): Promise<{ issueId: string; created: boolean }> {
  const now = env.now();
  const week = weekKey(now);
  const existing = await getBriefIssue(env.ctx, companyId, week);
  if (existing) {
    const issue = await env.ctx.issues.get(existing, companyId).catch(() => null);
    if (issue && !["cancelled"].includes(String(issue.status))) return { issueId: existing, created: false };
  }
  const roles = await getRoles(env.ctx, companyId);
  const owner = assignableUser(roles?.ownerUserId ?? null);
  const issue = await env.ctx.issues.create({
    companyId,
    title: `Daily brief: week of ${mondayLabel(now)}`,
    description:
      "The Operator posts one short brief here each morning: what was done yesterday, what waits on you (with links), risks, and today's plan. The Weekly retro lands here on Mondays.\n\nReply in the comments to answer or redirect the Operator.",
    status: "todo",
    priority: "medium",
    ...(owner ? { assigneeUserId: owner } : {}),
    originKind: ORIGIN.brief as `plugin:${string}`,
    originId: `brief:${companyId}:${week}`,
  });
  await saveBriefIssue(env.ctx, companyId, week, issue.id, now.toISOString());
  return { issueId: issue.id, created: true };
}

/** Post the brief as a comment by the Operator on this week's issue. Closes last week's. */
export async function postDailyBrief(env: Env, companyId: string, body: string, agentId: string | null): Promise<{ issueId: string; commentId: string; created: boolean }> {
  const text = body.trim();
  if (!text) throw new Error("The brief is empty.");
  if (text.length > 8000) throw new Error("The brief is too long (max 8000 characters). Keep it short.");
  const { issueId, created } = await ensureBriefIssue(env, companyId);
  const comment = await env.ctx.issues.createComment(issueId, text, companyId, agentId ? { authorAgentId: agentId } : undefined);
  if (created) {
    const last = await getBriefIssue(env.ctx, companyId, weekKey(new Date(env.now().getTime() - 7 * 86_400_000)));
    if (last && last !== issueId) {
      await env.ctx.issues.update(last, { status: "done" }, companyId).catch((error) => env.ctx.logger.info("Closing last week's brief failed", { error: message(error) }));
    }
  }
  return { issueId, commentId: String((comment as { id?: unknown }).id ?? ""), created };
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function params(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function runTool(env: Env, name: string, raw: unknown, run: ToolRunContext): Promise<ToolResult> {
  const companyId = run.companyId;
  const p = params(raw);
  try {
    if (name === TOOL_NAMES.brief) {
      const brief = await companyBrief(env, companyId, { windowHours: typeof p.windowHours === "number" ? p.windowHours : undefined });
      const stuck = brief.stuckFlows.length ? ` ${brief.stuckFlows.length} stuck ${brief.stuckFlows.length === 1 ? "stage" : "stages"} in the flows.` : "";
      return toolOk(`${brief.today} ${brief.waiting.length} waiting, health ${brief.health.status}, ${brief.agents.length} agents.${stuck}`, brief);
    }
    if (name === TOOL_NAMES.health) {
      const brief = await companyBrief(env, companyId);
      const include = p.includeWarnings !== false;
      const problems = brief.health.problems.filter((c) => include || c.status === "bad");
      return toolOk(problems.length === 0 && brief.health.agentAlerts.length === 0 ? "All systems ok." : `${problems.length} health ${problems.length === 1 ? "item" : "items"}, ${brief.health.agentAlerts.length} agent ${brief.health.agentAlerts.length === 1 ? "alert" : "alerts"}.`, {
        status: brief.health.status,
        problems,
        agentAlerts: brief.health.agentAlerts,
      });
    }
    if (name === TOOL_NAMES.waiting) {
      const brief = await companyBrief(env, companyId);
      return toolOk(brief.waiting.length === 0 ? "Nothing waits on the owner." : `${brief.waiting.length} ${brief.waiting.length === 1 ? "item waits" : "items wait"} on the owner.`, { items: brief.waiting, count: brief.waiting.length });
    }
    if (name === TOOL_NAMES.scorecards) {
      const brief = await companyBrief(env, companyId, { windowHours: 168 });
      return toolOk(`${brief.agents.length} agent scorecards.`, { items: brief.agents, count: brief.agents.length });
    }
    if (name === TOOL_NAMES.postBrief) {
      const body = typeof p.body === "string" ? p.body : "";
      const result = await postDailyBrief(env, companyId, body, run.agentId ?? null);
      return toolOk(result.created ? "Posted the brief on this week's new Daily brief issue." : "Posted the brief on this week's Daily brief issue.", result);
    }
    return toolFail(`Unknown tool ${name}`);
  } catch (error) {
    return toolFail(message(error));
  }
}
