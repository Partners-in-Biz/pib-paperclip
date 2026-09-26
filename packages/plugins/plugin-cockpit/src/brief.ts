/**
 * The Operator's view of the company (worker side): the same merge the page
 * does, from the projection plus host records the worker can read. Backs the
 * agent tools.
 */
import type { PluginContext, ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, toolFail, toolOk, type SetupStatus } from "@partnersinbiz/pib-plugin-kit";
import { assignableUser, ORIGIN } from "./constants.js";
import { getBriefIssue, getRoles, listSnapshots, saveBriefIssue } from "./db.js";
import { message, type Env } from "./env.js";
import { collectProblems, expectedPlugins, linkFor, listAgents, storedSnapshots } from "./health.js";
import {
  activityGroups,
  agentRows,
  groupKpis,
  healthGroups,
  hostWaiting,
  mergeWaiting,
  setupMissingCount,
  staleChecks,
  todayLine,
  worstOf,
  type AgentLite,
  type ApprovalLite,
  type CockpitSnapshot,
  type IssueLite,
  type RunLite,
  type WaitingEntry,
} from "./merge.js";
import { ownSnapshot } from "./own.js";
import { TOOL_NAMES } from "./tools.js";

const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : typeof value === "string" ? value : null);

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

/** Heartbeat runs of the last `days` days (core read of public.heartbeat_runs). */
export async function listRuns(ctx: PluginContext, companyId: string, days: number): Promise<RunLite[]> {
  try {
    const rows = await ctx.db.query<Record<string, unknown>>(
      `SELECT agent_id, status, started_at, finished_at, error FROM public.heartbeat_runs
        WHERE company_id = $1 AND started_at >= now() - ($2 || ' days')::interval
        ORDER BY started_at DESC LIMIT 1000`,
      [companyId, String(days)],
    );
    return rows.map((row) => ({
      agentId: String(row.agent_id),
      status: String(row.status ?? ""),
      startedAt: iso(row.started_at),
      finishedAt: iso(row.finished_at),
      error: row.error == null ? null : String(row.error).slice(0, 300),
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
  runs: RunLite[];
  approvals: ApprovalLite[];
  ownerIssues: IssueLite[];
  setupMissing: number;
  ownerUserId: string | null;
  listeningSince: string | null;
}

export async function loadCompanyData(env: Env, companyId: string, days = 7): Promise<CompanyData> {
  const roles = await getRoles(env.ctx, companyId);
  const stored = await storedSnapshots(env, companyId);
  const own = await ownSnapshot(env, companyId);
  const [agents, runs, approvals, ownerIssues, statuses] = await Promise.all([
    listAgents(env, companyId),
    listRuns(env.ctx, companyId, Math.max(days, 7)),
    listApprovals(env.ctx, companyId),
    listUserIssues(env.ctx, companyId, roles?.ownerUserId ?? null),
    setupStatuses(env, companyId),
  ]);
  const enabled = await enabledModules(env, companyId, Object.keys(statuses));
  const missing = setupMissingCount(Object.fromEntries(Object.entries(statuses).filter(([key]) => enabled[key])), null);
  return {
    snapshots: [...stored.map((s) => s.snapshot), own],
    receivedAt: Object.fromEntries(stored.map((s) => [s.snapshot.plugin, s.receivedAt])),
    agents,
    runs,
    approvals,
    ownerIssues,
    setupMissing: missing,
    ownerUserId: roles?.ownerUserId ?? null,
    listeningSince: roles?.createdAt ?? null,
  };
}

export function waitingFrom(data: Pick<CompanyData, "snapshots" | "approvals" | "ownerIssues" | "setupMissing">): WaitingEntry[] {
  return mergeWaiting([
    ...data.snapshots.map((snapshot) => ({ source: snapshot.plugin, sourceTitle: snapshot.title, items: snapshot.waiting })),
    { source: "host", sourceTitle: "Paperclip", items: hostWaiting({ approvals: data.approvals, myIssues: data.ownerIssues, setupMissing: data.setupMissing }) },
  ]);
}

function pct(ratio: number | null): number | null {
  return ratio === null ? null : Math.round(ratio * 100);
}

/** Compact JSON for the Operator: waiting, health, KPIs, activity, agents incl. spend/budget. */
export async function companyBrief(env: Env, companyId: string, options: { windowHours?: number } = {}) {
  const windowHours = Math.min(Math.max(Math.round(options.windowHours ?? 24), 1), 720);
  const data = await loadCompanyData(env, companyId, Math.ceil(windowHours / 24));
  const now = env.now();
  const company = await env.ctx.companies.get(companyId).catch(() => null);
  const prefix = company?.issuePrefix ?? null;
  const link = (href: string | null | undefined) => (href ? linkFor(href, prefix) : null);

  const expected = await expectedPlugins(env, companyId, Object.keys(data.receivedAt));
  const stale = staleChecks({ expected, lastSnapshot: Object.fromEntries(data.snapshots.map((s) => [s.plugin, s.checkedAt])), now, listeningSince: data.listeningSince });
  const groups = healthGroups(data.snapshots, stale);
  const problems = await collectProblems(env, companyId, { snapshots: data.snapshots, agents: data.agents, listeningSince: data.listeningSince });
  const waiting = waitingFrom(data);
  const agents = agentRows(data.agents, { runs: data.runs, snapshots: data.snapshots, since: new Date(now.getTime() - 7 * 86_400_000) });
  const activity = activityGroups({ snapshots: data.snapshots, runs: data.runs, agents: data.agents, now, windowMs: windowHours * 3_600_000, perGroup: 6 });
  const kpis = groupKpis(data.snapshots);
  const health = worstOf(groups.map((g) => g.status));
  const problemCount = problems.entries.filter((e) => e.status === "bad").length;

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
    waiting: waiting.map((w) => ({ title: w.title, why: w.why, kind: w.kind, href: link(w.href), issueId: w.issueId ?? null, since: w.since ?? null, from: w.sourceTitle })),
    health: {
      status: health,
      problems: groups.flatMap((g) => g.checks.filter((c) => c.status !== "ok").map((c) => ({ plugin: g.title, status: c.status, title: c.title, detail: c.detail ?? null, fix: c.fix ?? null, href: link(c.href), since: c.since ?? null }))),
      agentAlerts: problems.entries.filter((e) => e.plugin === "agents").map((e) => ({ title: e.title, detail: e.detail ?? null, href: link(e.href) })),
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
      runs7d: a.runs,
      quality: a.quality.map((q) => ({ label: q.label, value: q.value, tone: q.tone ?? "neutral" })),
    })),
    setupMissing: data.setupMissing,
    links: { cockpit: link("/cockpit"), setup: link("/setup") },
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
      return toolOk(`${brief.today} ${brief.waiting.length} waiting, health ${brief.health.status}, ${brief.agents.length} agents.`, brief);
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
