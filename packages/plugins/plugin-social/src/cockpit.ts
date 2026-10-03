/**
 * Social snapshot for the Company Cockpit (`GET /cockpit` and the hourly
 * `cockpit.snapshot` event, kit cockpit.ts). Read-only and cheap: a few
 * SELECTs on our own tables and kit job/state reads, no provider calls.
 * Every part is wrapped so one failing query never breaks the snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  cleanFlowReports,
  decisionStats,
  emptySnapshot,
  jobHealth,
  linkedAgentId,
  outboxHealth,
  publishCockpitSnapshot,
  withClientParam,
  type ActivityItem,
  type CockpitKpi,
  type CockpitSnapshot,
  type FlowStageReport,
  type HealthCheck,
  type QualityMetric,
  type TeamMemberReport,
  type Tone,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit";
import { clientPrefix, scopeOfRow } from "./clients.js";
import { loadSocialConfig } from "./config.js";
import { iso, table } from "./db.js";
import { clip } from "./domain.js";
import { failedPublishSql, handoffPayload, needsReplySql, repurposeDraftCounts, repurposeRef } from "./done-checks.js";
import { enqueueRecentLeads } from "./handoff.js";
import { legacySocialAgent, SOCIAL_HIRE_ROLE } from "./hire.js";
import { socialProjectId } from "./issues.js";
import { knownCompanies, socialOn } from "./modules.js";
import { PLAN_HANDOFF_KIND, planScopeOfKey, postsMadeInScope } from "./plan-trigger.js";
import { isSocialPlatform, PLAN_ROUTINE_KEY, PLATFORM_LABELS, PLUGIN_ID } from "./platforms.js";
import { TRIAGE_PURPOSE } from "./triage.js";

/** Scheduled jobs and their interval in minutes (manifest schedules). */
export const SOCIAL_JOBS: Array<{ key: string; title: string; everyMinutes: number }> = [
  { key: "publish-due", title: "Publish due posts", everyMinutes: 5 },
  { key: "refresh-tokens", title: "Refresh account tokens", everyMinutes: 60 },
  { key: "collect-metrics", title: "Collect post metrics", everyMinutes: 30 },
  { key: "poll-inbox", title: "Poll social inbox", everyMinutes: 15 },
  { key: "poll-rss", title: "Poll RSS feeds", everyMinutes: 15 },
  { key: "score-posts", title: "Score posts (Growth Lab)", everyMinutes: 24 * 60 },
  { key: "measure-experiments", title: "Measure experiments (Growth Lab)", everyMinutes: 24 * 60 },
  { key: "redeliver", title: "Re-send leads to the CRM", everyMinutes: 10 },
];

type Scoped = { client_kind: string | null; client_ref: string | null; client_name: string | null };

const POSTS = "/social?tab=posts";

function path(base: string, row: Scoped | null): string {
  return withClientParam(base, row ? scopeOfRow(row) : null);
}

function platformName(platform: string): string {
  return isSocialPlatform(platform) ? PLATFORM_LABELS[platform] : platform;
}

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function snippet(value: string, max = 60): string {
  return clip(value.replace(/\s+/g, " ").trim(), max);
}

/** "+12%" / "−5%" from a lift ratio (0.12 → +12%). */
export function formatLift(lift: number): string {
  const pct = Math.round(lift * 100);
  return pct > 0 ? `+${pct}%` : pct < 0 ? `−${Math.abs(pct)}%` : "0%";
}

/** Share with a tone: warn above `warnAt`, bad above `badAt`. */
export function rateTone(rate: number, warnAt: number, badAt: number): Tone {
  return rate > badAt ? "bad" : rate > warnAt ? "warn" : "ok";
}

async function part<T>(ctx: PluginContext, label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    ctx.logger.info("Social cockpit part failed", { part: label, error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

// ── KPIs ────────────────────────────────────────────────────────────────────

async function kpis(ctx: PluginContext, companyId: string): Promise<CockpitKpi[]> {
  const rows = await ctx.db.query<Record<string, string | null>>(
    `SELECT
       (SELECT count(*) FROM ${table(ctx, "posts")} WHERE company_id = $1 AND status IN ('published', 'partially_published') AND published_at >= now() - interval '7 days')::text AS published,
       (SELECT count(*) FROM ${table(ctx, "posts")} WHERE company_id = $1 AND status = 'scheduled' AND scheduled_at >= now() AND scheduled_at < now() + interval '7 days')::text AS scheduled,
       (SELECT count(*) FROM ${table(ctx, "inbox_items")} WHERE company_id = $1 AND ${needsReplySql()})::text AS inbox,
       (SELECT count(*) FROM ${table(ctx, "growth_experiments")} WHERE company_id = $1 AND status = 'running')::text AS experiments,
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY lift) FROM ${table(ctx, "post_scores")}
          WHERE company_id = $1 AND metric_window = '7d' AND lift IS NOT NULL AND published_at >= now() - interval '30 days')::text AS lift,
       (SELECT count(*) FROM ${table(ctx, "post_scores")}
          WHERE company_id = $1 AND metric_window = '7d' AND lift IS NOT NULL AND published_at >= now() - interval '30 days')::text AS scored`,
    [companyId],
  );
  const r = rows[0] ?? {};
  const published = count(r.published);
  const scheduled = count(r.scheduled);
  const inbox = count(r.inbox);
  const experiments = count(r.experiments);
  const scored = count(r.scored);
  const lift = r.lift == null ? null : Number(r.lift);
  const liftKnown = scored > 0 && lift !== null && Number.isFinite(lift);
  return [
    { key: "posts_published_7d", label: "Posts published (7 days)", value: String(published), raw: published, tone: "neutral", href: POSTS, group: "marketing" },
    { key: "posts_scheduled_7d", label: "Scheduled (next 7 days)", value: String(scheduled), raw: scheduled, tone: scheduled === 0 ? "warn" : "ok", href: POSTS, group: "marketing" },
    {
      key: "engagement_lift_7d",
      label: "Engagement lift (median, 7-day score)",
      value: liftKnown ? formatLift(lift!) : "—",
      raw: liftKnown ? Math.round(lift! * 1000) / 1000 : null,
      tone: liftKnown ? (lift! >= 0 ? "ok" : "warn") : "neutral",
      delta: liftKnown ? `${plural(scored, "scored post")} in 30 days` : null,
      href: "/social?tab=growth",
      group: "marketing",
    },
    { key: "inbox_needs_reply", label: "Inbox needing a reply", value: String(inbox), raw: inbox, tone: inbox > 20 ? "warn" : "neutral", href: "/social?tab=inbox", group: "marketing" },
    { key: "experiments_running", label: "Experiments running", value: String(experiments), raw: experiments, tone: "neutral", href: "/social?tab=growth", group: "marketing" },
  ];
}

// ── health ──────────────────────────────────────────────────────────────────

interface AccountHealthRow extends Scoped {
  id: string;
  platform: string;
  display_name: string;
  status: string;
  token_expires_at: string | null;
  last_error: string | null;
  updated_at: string | null;
}

export function accountChecks(rows: AccountHealthRow[]): HealthCheck[] {
  const checks: HealthCheck[] = [];
  for (const row of rows) {
    const name = `${clientPrefix(row)}${platformName(row.platform)} · ${row.display_name}`;
    const href = path("/social?tab=accounts", row);
    if (row.status === "needs_reconnect") {
      checks.push({
        key: `token:${row.platform}:${row.id}`,
        title: `Reconnect ${name}`,
        status: "bad",
        detail: row.last_error ? clip(row.last_error, 300) : "The account's access stopped working.",
        href,
        fix: "Open Social → Accounts and click Reconnect on this account (a person signs in to the platform).",
        since: row.updated_at,
      });
    } else {
      const when = row.token_expires_at ? ` on ${row.token_expires_at.slice(0, 10)}` : "";
      checks.push({
        key: `token:${row.platform}:${row.id}`,
        title: `${name} token expires soon`,
        status: "warn",
        detail: `The token expires${when} and could not be refreshed automatically.${row.last_error ? ` Last error: ${clip(row.last_error, 200)}` : ""}`,
        href,
        fix: "Reconnect the account on Social → Accounts before it expires.",
        since: row.updated_at,
      });
    }
  }
  if (checks.length === 0) checks.push({ key: "accounts", title: "Connected accounts", status: "ok" });
  return checks;
}

/** The `heartbeat_runs.error_code` the host gives a run it refused to start because its workspace could not be made. */
export const WORKSPACE_FAILURE_CODE = "workspace_validation_failed";

/** The fix for the Social agent stopping at the workspace check, in plain words (agents can do it too: any caller with company access may PATCH a project). */
export const WORKSPACE_FIX =
  "Social needs no git repo. Open the Social project in Paperclip → Configuration and set its execution workspace to a shared workspace (isolated worktrees off); an agent can do the same with PATCH /api/projects/<project id> and {\"executionWorkspacePolicy\":{\"enabled\":false,\"defaultMode\":\"shared_workspace\"}}. Then retry the stopped issues.";

export interface AgentRunRow {
  error_code: string | null;
  at: string | null;
}

/**
 * The Social agent's latest runs on the Social project's issues, newest first.
 * Flags it when its most recent runs all stopped at the host's workspace check
 * (the project folder is not a git checkout and the host default asks for an
 * isolated worktree): nothing the agent is given there runs until that is
 * fixed. A later run that got past the check clears it. Pure.
 */
export function agentRunChecks(rows: AgentRunRow[], projectId: string): HealthCheck[] {
  const streak = rows.findIndex((row) => row.error_code !== WORKSPACE_FAILURE_CODE);
  const failing = streak === -1 ? rows.length : streak;
  if (failing === 0) return [{ key: "agent-runs", title: "Social agent runs", status: "ok" }];
  return [
    {
      key: "agent-runs",
      title: "The Social agent cannot start: its project has no workspace it can use",
      status: "bad",
      detail: `${plural(failing, "run")} stopped at the workspace check before the agent started (${WORKSPACE_FAILURE_CODE}), so the weekly plan, first plans, reply queues and repurpose tasks wait.`,
      href: `/projects/${projectId}/configuration`,
      fix: WORKSPACE_FIX,
      since: rows[failing - 1]?.at ?? null,
    },
  ];
}

async function healthChecks(ctx: PluginContext, companyId: string, agentId: string | null): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [];
  for (const job of SOCIAL_JOBS) {
    checks.push(await part(ctx, `job:${job.key}`, () => jobHealth(ctx, job.key, job.title, job.everyMinutes), { key: `job:${job.key}`, title: job.title, status: "ok" as const, detail: "Run history unavailable." }));
  }
  checks.push(
    ...(await part(
      ctx,
      "accounts",
      async () =>
        accountChecks(
          await ctx.db.query<AccountHealthRow>(
            `SELECT id, platform, display_name, status, client_kind, client_ref, client_name, token_expires_at::text AS token_expires_at, last_error, updated_at::text AS updated_at
               FROM ${table(ctx, "accounts")}
              WHERE company_id = $1 AND token_enc IS NOT NULL AND status <> 'disabled'
                AND (status IN ('needs_reconnect', 'expiring')
                     OR (token_expires_at IS NOT NULL AND token_expires_at < now() + interval '7 days' AND refresh_token_enc IS NULL))
              ORDER BY status DESC, token_expires_at NULLS LAST LIMIT 20`,
            [companyId],
          ),
        ),
      [] as HealthCheck[],
    )),
  );
  if (agentId) {
    checks.push(
      ...(await part(
        ctx,
        "agent-runs",
        async () => {
          const projectId = await socialProjectId(ctx, companyId);
          if (!projectId) return [] as HealthCheck[];
          // Runs on the Social project's issues only: a linked agent may also work in projects with their own workspace problems.
          const rows = await ctx.db.query<AgentRunRow>(
            `SELECT error_code, created_at::text AS at FROM public.heartbeat_runs
              WHERE company_id = $1 AND agent_id = $2 AND context_snapshot->>'projectId' = $3 AND created_at >= now() - interval '7 days'
              ORDER BY created_at DESC LIMIT 5`,
            [companyId, agentId, projectId],
          );
          return agentRunChecks(rows, projectId);
        },
        [] as HealthCheck[],
      )),
    );
  }
  // Leads handed to the CRM that it has not answered (kit outbox).
  checks.push(await part(ctx, "outbox", () => outboxHealth(ctx, companyId), { key: "outbox", title: "Cross-plugin deliveries", status: "ok" as const }));
  const failed = await part(
    ctx,
    "failed",
    async () => {
      const rows = await ctx.db.query<{ failed: string; since: string | null }>(
        `SELECT count(*)::text AS failed, min(updated_at)::text AS since FROM ${table(ctx, "destinations")}
          WHERE company_id = $1 AND status = 'failed' AND updated_at >= now() - interval '24 hours'`,
        [companyId],
      );
      return { failed: count(rows[0]?.failed), since: rows[0]?.since ?? null };
    },
    null as { failed: number; since: string | null } | null,
  );
  if (failed) {
    checks.push(
      failed.failed > 0
        ? {
            key: "publish-failures",
            title: "Posts failed to publish (24 hours)",
            status: "bad",
            detail: `${plural(failed.failed, "destination")} failed after every retry.`,
            href: POSTS,
            fix: "Open the \"Social post failed to publish\" issue: reconnect the account or fix the content, then Retry.",
            since: failed.since,
          }
        : { key: "publish-failures", title: "Posts failed to publish (24 hours)", status: "ok" },
    );
  }
  return checks;
}

// ── waiting ─────────────────────────────────────────────────────────────────

async function waitingItems(ctx: PluginContext, companyId: string): Promise<WaitingItem[]> {
  const items: WaitingItem[] = [];
  const posts = await ctx.db.query<Scoped & { id: string; body: string; review_issue_id: string | null; updated_at: string | null }>(
    `SELECT id, body, client_kind, client_ref, client_name, review_issue_id, updated_at::text AS updated_at
       FROM ${table(ctx, "posts")} WHERE company_id = $1 AND status = 'review' ORDER BY updated_at LIMIT 20`,
    [companyId],
  );
  for (const post of posts) {
    items.push({
      key: `social:review:${post.id}`,
      title: `${clientPrefix(post)}Approve post: ${snippet(post.body)}`,
      why: post.review_issue_id
        ? "A person approves every post before it is scheduled. The Reviewer checks it first on its issue."
        : "A person approves every post before it is scheduled.",
      href: path(POSTS, post),
      issueId: post.review_issue_id,
      kind: "review",
      since: post.updated_at,
    });
  }
  // Approved, but no time: the Social agent has a task to pick one (or a person does, when there is no agent).
  const unscheduled = await ctx.db.query<Scoped & { id: string; body: string; schedule_issue_id: string | null; updated_at: string | null }>(
    `SELECT id, body, client_kind, client_ref, client_name, schedule_issue_id, updated_at::text AS updated_at
       FROM ${table(ctx, "posts")} WHERE company_id = $1 AND status = 'approved' ORDER BY updated_at LIMIT 20`,
    [companyId],
  );
  for (const post of unscheduled) {
    items.push({
      key: `social:schedule:${post.id}`,
      title: `${clientPrefix(post)}Schedule approved post: ${snippet(post.body)}`,
      why: post.schedule_issue_id
        ? "Approved, but it has no publish time. The Social agent has a task to pick one."
        : "Approved, but it has no publish time. Pick one on the post, or send it back to draft.",
      href: path(POSTS, post),
      issueId: post.schedule_issue_id,
      kind: "other",
      since: post.updated_at,
    });
  }
  // Signing in again is a person's one-time grant.
  const reconnect = await ctx.db.query<Scoped & { id: string; platform: string; display_name: string; reconnect_issue_id: string | null; updated_at: string | null }>(
    `SELECT id, platform, display_name, client_kind, client_ref, client_name, reconnect_issue_id, updated_at::text AS updated_at
       FROM ${table(ctx, "accounts")} WHERE company_id = $1 AND status = 'needs_reconnect' AND token_enc IS NOT NULL ORDER BY updated_at LIMIT 20`,
    [companyId],
  );
  for (const account of reconnect) {
    items.push({
      key: `social:reconnect:${account.id}`,
      title: `${clientPrefix(account)}Reconnect ${platformName(account.platform)} · ${account.display_name}`,
      why: "The account's sign-in stopped working. A person signs in again on Social → Accounts; posts to it fail until then.",
      href: path("/social?tab=accounts", account),
      issueId: account.reconnect_issue_id,
      kind: "grant",
      since: account.updated_at,
    });
  }
  const escalated = await ctx.db.query<Scoped & { id: string; platform: string | null; kind: string; body: string; triage_issue_id: string | null; created_at: string | null }>(
    `SELECT id, platform, kind, body, client_kind, client_ref, client_name, triage_issue_id, created_at::text AS created_at
       FROM ${table(ctx, "inbox_items")}
      WHERE company_id = $1 AND status = 'new' AND triage->>'action' = 'escalated' AND COALESCE(triage->'corrected'->>'escalate', 'yes') = 'yes'
      ORDER BY created_at LIMIT 20`,
    [companyId],
  );
  for (const item of escalated) {
    items.push({
      key: `social:escalated:${item.id}`,
      title: `${clientPrefix(item)}Check a ${item.kind} on ${item.platform ? platformName(item.platform) : "social"}: ${snippet(item.body)}`,
      why: "Jev flagged possible legal, safety or PR risk, so the agent does not reply. A person decides what to say.",
      href: path("/social?tab=inbox", item),
      issueId: item.triage_issue_id,
      kind: "judgement",
      since: item.created_at,
    });
  }
  const changes = await ctx.db.query<Scoped & { id: string; reason: string; approval_issue_id: string | null; created_at: string | null }>(
    `SELECT c.id, c.reason, c.approval_issue_id, c.created_at::text AS created_at, p.client_kind, p.client_ref, p.client_name
       FROM ${table(ctx, "growth_playbook_changes")} c JOIN ${table(ctx, "growth_programs")} p ON p.id = c.program_id
      WHERE c.company_id = $1 AND c.status = 'pending' AND p.autopilot <> 'full'
      ORDER BY c.created_at LIMIT 20`,
    [companyId],
  );
  for (const change of changes) {
    items.push({
      key: `social:playbook-change:${change.id}`,
      title: `${clientPrefix(change)}Keep or discard a playbook change: ${snippet(change.reason)}`,
      why: "In safe autopilot a person decides every playbook change.",
      href: path("/social?tab=growth", change),
      issueId: change.approval_issue_id,
      kind: "judgement",
      since: change.created_at,
    });
  }
  const experiments = await ctx.db.query<Scoped & { id: string; hypothesis: string; approval_issue_id: string | null; created_at: string | null }>(
    `SELECT e.id, e.hypothesis, e.approval_issue_id, e.created_at::text AS created_at, p.client_kind, p.client_ref, p.client_name
       FROM ${table(ctx, "growth_experiments")} e JOIN ${table(ctx, "growth_programs")} p ON p.id = e.program_id
      WHERE e.company_id = $1 AND e.status = 'proposed' AND p.autopilot <> 'full'
      ORDER BY e.created_at LIMIT 20`,
    [companyId],
  );
  for (const e of experiments) {
    items.push({
      key: `social:experiment:${e.id}`,
      title: `${clientPrefix(e)}Approve an experiment: ${snippet(e.hypothesis)}`,
      why: "In safe autopilot a person approves each experiment before the agent runs it.",
      href: path("/social?tab=growth", e),
      issueId: e.approval_issue_id,
      kind: "judgement",
      since: e.created_at,
    });
  }
  return items;
}

// ── activity ────────────────────────────────────────────────────────────────

async function activityItems(ctx: PluginContext, companyId: string): Promise<ActivityItem[]> {
  const out: ActivityItem[] = [];
  const posts = await ctx.db.query<Scoped & { id: string; body: string; published_at: string; status: string; created_by_agent_id: string | null; n: string }>(
    `SELECT p.id, p.body, p.client_kind, p.client_ref, p.client_name, p.published_at::text AS published_at, p.status, p.created_by_agent_id,
            (SELECT count(*) FROM ${table(ctx, "destinations")} d WHERE d.post_id = p.id AND d.status = 'published')::text AS n
       FROM ${table(ctx, "posts")} p
      WHERE p.company_id = $1 AND p.published_at IS NOT NULL ORDER BY p.published_at DESC LIMIT 10`,
    [companyId],
  );
  for (const post of posts) {
    const n = count(post.n);
    out.push({
      at: post.published_at,
      text: `${clientPrefix(post)}Published "${snippet(post.body, 50)}" to ${plural(n, "account")}${post.status === "partially_published" ? " (some failed)" : ""}`,
      href: path(POSTS, post),
      agentId: post.created_by_agent_id,
    });
  }
  const measured = await ctx.db.query<{ hypothesis: string; verdict: string | null; measured_at: string }>(
    `SELECT hypothesis, verdict, measured_at::text AS measured_at FROM ${table(ctx, "growth_experiments")}
      WHERE company_id = $1 AND measured_at IS NOT NULL ORDER BY measured_at DESC LIMIT 5`,
    [companyId],
  );
  for (const e of measured) {
    out.push({ at: e.measured_at, text: `Measured experiment "${snippet(e.hypothesis, 50)}": ${(e.verdict ?? "inconclusive").replace("_", " ")}`, href: "/social?tab=growth" });
  }
  const versions = await ctx.db.query<Scoped & { version: number; reason: string; created_at: string }>(
    `SELECT v.version, v.reason, v.created_at::text AS created_at, p.client_kind, p.client_ref, p.client_name
       FROM ${table(ctx, "growth_playbook_versions")} v JOIN ${table(ctx, "growth_programs")} p ON p.id = v.program_id
      WHERE p.company_id = $1 AND v.version > 1 ORDER BY v.created_at DESC LIMIT 5`,
    [companyId],
  );
  for (const v of versions) {
    out.push({ at: v.created_at, text: `${clientPrefix(v)}Updated the playbook to v${v.version}: ${snippet(v.reason, 60)}`, href: path("/social?tab=growth", v) });
  }
  const handoffs = await ctx.db.query<{ payload: unknown; issue_id: string | null; created_at: string }>(
    `SELECT payload, issue_id, created_at::text AS created_at FROM ${table(ctx, "handoffs")}
      WHERE company_id = $1 AND kind = 'repurpose' AND issue_id IS NOT NULL ORDER BY created_at DESC LIMIT 5`,
    [companyId],
  );
  for (const h of handoffs) {
    const payload = (typeof h.payload === "string" ? JSON.parse(h.payload) : h.payload) as { title?: string } | null;
    out.push({ at: h.created_at, text: `Opened a repurpose task for "${snippet(payload?.title ?? "an SEO page", 60)}"`, href: null });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 10);
}

// ── quality ─────────────────────────────────────────────────────────────────

async function qualityMetrics(ctx: PluginContext, companyId: string, agentId: string | null): Promise<QualityMetric[]> {
  const out: QualityMetric[] = [];
  const rows = await ctx.db.query<Record<string, string | null>>(
    `SELECT
       (SELECT count(*) FROM ${table(ctx, "posts")} WHERE company_id = $1 AND updated_at >= now() - interval '30 days' AND review_returns > 0)::text AS returned,
       (SELECT count(*) FROM ${table(ctx, "posts")} WHERE company_id = $1 AND updated_at >= now() - interval '30 days'
          AND (review_returns > 0 OR status IN ('approved', 'scheduled', 'publishing', 'published', 'partially_published', 'failed')))::text AS reviewed,
       (SELECT count(*) FROM ${table(ctx, "growth_experiments")} WHERE company_id = $1 AND status = 'rejected' AND updated_at >= now() - interval '30 days')::text AS exp_rejected,
       (SELECT count(*) FROM ${table(ctx, "growth_experiments")} WHERE company_id = $1 AND approved_at >= now() - interval '30 days')::text AS exp_approved,
       (SELECT count(*) FROM ${table(ctx, "growth_playbook_changes")} WHERE company_id = $1 AND status = 'discarded' AND decided_at >= now() - interval '30 days')::text AS ch_discarded,
       (SELECT count(*) FROM ${table(ctx, "growth_playbook_changes")} WHERE company_id = $1 AND status = 'kept' AND decided_at >= now() - interval '30 days')::text AS ch_kept,
       (SELECT count(*) FROM ${table(ctx, "destinations")} WHERE company_id = $1 AND status = 'failed' AND updated_at >= now() - interval '7 days')::text AS dest_failed,
       (SELECT count(*) FROM ${table(ctx, "destinations")} WHERE company_id = $1 AND status IN ('published', 'failed') AND updated_at >= now() - interval '7 days')::text AS dest_total`,
    [companyId],
  );
  const r = rows[0] ?? {};
  const returned = count(r.returned);
  const reviewed = count(r.reviewed);
  const returnRate = reviewed > 0 ? returned / reviewed : 0;
  out.push({
    key: "posts_changes_requested_30d",
    label: "Posts sent back from review (30 days)",
    value: reviewed > 0 ? `${returned} of ${reviewed}` : "0",
    raw: Math.round(returnRate * 1000) / 1000,
    tone: reviewed > 0 ? rateTone(returnRate, 0.2, 0.4) : "neutral",
    agentId,
  });
  const rejected = count(r.exp_rejected) + count(r.ch_discarded);
  const decided = rejected + count(r.exp_approved) + count(r.ch_kept);
  const rejectRate = decided > 0 ? rejected / decided : 0;
  out.push({
    key: "growth_rejected_30d",
    label: "Growth Lab proposals rejected (30 days)",
    value: decided > 0 ? `${rejected} of ${decided}` : "0",
    raw: Math.round(rejectRate * 1000) / 1000,
    tone: decided > 0 ? rateTone(rejectRate, 0.3, 0.5) : "neutral",
    agentId,
  });
  const failed = count(r.dest_failed);
  const total = count(r.dest_total);
  const failRate = total > 0 ? failed / total : 0;
  out.push({
    key: "publish_failure_rate_7d",
    label: "Publish failure rate (7 days)",
    value: total > 0 ? `${Math.round(failRate * 100)}% (${failed} of ${total})` : "—",
    raw: Math.round(failRate * 1000) / 1000,
    tone: total > 0 ? rateTone(failRate, 0.05, 0.2) : "neutral",
  });
  const stats = await part(ctx, "decisions", () => decisionStats(ctx, companyId, 30), []);
  const triage = stats.filter((s) => s.purpose === TRIAGE_PURPOSE);
  const decisions = triage.reduce((sum, s) => sum + count(s.total), 0);
  const corrected = triage.reduce((sum, s) => sum + count(s.corrected), 0);
  const correctRate = decisions > 0 ? corrected / decisions : 0;
  out.push({
    key: "triage_corrected_30d",
    label: "Inbox triage corrected by people (30 days)",
    value: decisions > 0 ? `${corrected} of ${decisions}` : "—",
    raw: Math.round(correctRate * 1000) / 1000,
    tone: decisions > 0 ? rateTone(correctRate, 0.1, 0.25) : "neutral",
  });
  return out;
}

// ── flows (kit FLOWS: social.drafts, social.approval, social.scheduled) ─────

const DAY_MS = 24 * 3600_000;
const OPEN_ISSUE = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

/** A repurpose task, the weekly plan or a first plan with no draft yet is stuck after this many days. */
export const DRAFT_STUCK_DAYS = 2;

function ageMs(value: string | null | undefined, now: Date): number | null {
  const at = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, now.getTime() - at) : null;
}

function days(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

/** Work that should produce drafts but has none yet: a repurpose task, the weekly plan, or a scope's first plan. */
export interface DraftWork {
  kind: "repurpose" | "plan" | "first_plan";
  createdAt: string | null;
}

/**
 * `social.drafts`: posts in draft, plus open work that should make drafts
 * and has none yet (a repurpose task with no draft for its page, by the same
 * rule as its done-check; the open weekly plan with no post drafted since it
 * opened; a scope's open first plan with none drafted in it since). Stuck:
 * that work over two days old. Pure.
 */
export function draftsFlow(input: { drafts: number; work: DraftWork[] }, now: Date): FlowStageReport {
  const late = input.work.map((w) => ({ ...w, age: ageMs(w.createdAt, now) ?? 0 })).filter((w) => w.age > DRAFT_STUCK_DAYS * DAY_MS);
  const repurpose = late.filter((w) => w.kind === "repurpose").length;
  const plans = late.filter((w) => w.kind === "plan").length;
  const firsts = late.filter((w) => w.kind === "first_plan").length;
  const parts = [
    repurpose ? plural(repurpose, "repurpose task") : null,
    plans ? (plans === 1 ? "the weekly plan" : plural(plans, "weekly plan")) : null,
    firsts ? (firsts === 1 ? "a first plan" : plural(firsts, "first plan")) : null,
  ].filter((part): part is string => part !== null);
  const what = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] ?? "");
  return {
    stage: "social.drafts",
    count: input.drafts + input.work.length,
    stuck: late.length,
    stuckReason: late.length ? `${what} over ${DRAFT_STUCK_DAYS} days old with no draft` : null,
    oldestDays: late.length ? days(Math.max(...late.map((w) => w.age))) : null,
  };
}

/** Is the repurpose task's issue still open? A failed lookup counts as open (never hide work); a deleted issue does not. */
async function issueStillOpen(ctx: PluginContext, companyId: string, issueId: string): Promise<boolean> {
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    return Boolean(issue) && OPEN_ISSUE.has(String(issue!.status));
  } catch {
    return true;
  }
}

async function draftWork(ctx: PluginContext, companyId: string): Promise<{ drafts: number; work: DraftWork[] }> {
  const posts = table(ctx, "posts");
  const counted = await ctx.db.query<{ drafts: string }>(`SELECT count(*)::text AS drafts FROM ${posts} WHERE company_id = $1 AND status = 'draft'`, [companyId]);
  const handoffs = await ctx.db.query<{ key: string; issue_id: string; payload: unknown; created_at: string | null }>(
    `SELECT key, issue_id, payload, created_at::text AS created_at FROM ${table(ctx, "handoffs")}
      WHERE company_id = $1 AND kind = 'repurpose' AND issue_id IS NOT NULL AND created_at >= now() - interval '30 days'
      ORDER BY created_at LIMIT 50`,
    [companyId],
  );
  const drafted = await repurposeDraftCounts(ctx, companyId, handoffs.map((h) => repurposeRef(h.key, handoffPayload(h.payload))));
  const work: DraftWork[] = [];
  for (const h of handoffs) {
    if ((drafted.get(h.key) ?? 0) > 0 || !(await issueStillOpen(ctx, companyId, h.issue_id))) continue;
    work.push({ kind: "repurpose", createdAt: iso(h.created_at) });
  }
  // The weekly review & plan routine's open issue, with no post drafted since it opened (RSS and reply drafts do not count).
  // The host opens it as a routine_execution issue whose origin id is the routine's own id, so look the routine up first.
  const routineId = await part(ctx, "plan-routine", async () => (await ctx.routines.managed.get(PLAN_ROUTINE_KEY, companyId)).routineId, null as string | null);
  const plans = routineId ? await part(ctx, "plan-issues", async () => (await ctx.issues.list({ companyId, originId: routineId, limit: 10 })).filter((i) => OPEN_ISSUE.has(String(i.status))), []) : [];
  for (const plan of plans) {
    const since = iso(plan.createdAt);
    if (!since) continue;
    const made = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${posts} WHERE company_id = $1 AND created_at >= $2::timestamptz AND source NOT IN ('rss', 'inbox_reply')`,
      [companyId, since],
    );
    if (count(made[0]?.n) === 0) work.push({ kind: "plan", createdAt: since });
  }
  // First plans (a scope whose account connected with nothing planned): open, with no post drafted in their scope since.
  const first = await part(
    ctx,
    "first-plans",
    () =>
      ctx.db.query<{ issue_id: string; payload: unknown; created_at: string | null }>(
        `SELECT issue_id, payload, created_at::text AS created_at FROM ${table(ctx, "handoffs")}
          WHERE company_id = $1 AND kind = '${PLAN_HANDOFF_KIND}' AND issue_id IS NOT NULL AND created_at >= now() - interval '30 days'
          ORDER BY created_at LIMIT 25`,
        [companyId],
      ),
    [] as Array<{ issue_id: string; payload: unknown; created_at: string | null }>,
  );
  for (const plan of first) {
    const since = iso(plan.created_at);
    const key = handoffPayload(plan.payload).scope;
    const scope = typeof key === "string" ? planScopeOfKey(key) : undefined;
    if (!since || scope === undefined || !(await issueStillOpen(ctx, companyId, plan.issue_id))) continue;
    if ((await postsMadeInScope(ctx, companyId, scope, since)) === 0) work.push({ kind: "first_plan", createdAt: since });
  }
  return { drafts: count(counted[0]?.drafts), work };
}

/** `social.approval`: posts in review. Stuck: their proposed time passed while they waited. */
async function approvalFlow(ctx: PluginContext, companyId: string, now: Date): Promise<FlowStageReport> {
  const rows = await ctx.db.query<{ n: string; late: string; oldest: string | null }>(
    `SELECT count(*)::text AS n, count(*) FILTER (WHERE scheduled_at IS NOT NULL AND scheduled_at < now())::text AS late, min(updated_at)::text AS oldest
       FROM ${table(ctx, "posts")} WHERE company_id = $1 AND status = 'review'`,
    [companyId],
  );
  const n = count(rows[0]?.n);
  const late = count(rows[0]?.late);
  const oldest = ageMs(rows[0]?.oldest, now);
  return {
    stage: "social.approval",
    count: n,
    stuck: late,
    stuckReason: late ? `${plural(late, "post")} past ${late === 1 ? "its" : "their"} proposed time` : null,
    oldestDays: n && oldest != null ? days(oldest) : null,
  };
}

/**
 * `social.scheduled`: posts scheduled or publishing, approved posts still
 * without a time, and failed publishes. Stuck: a failed publish (not retried,
 * detached or back in draft: the same rule as the failed-post done-check),
 * or an approved post with no time for over a day.
 */
async function scheduledFlow(ctx: PluginContext, companyId: string, now: Date): Promise<FlowStageReport> {
  const failed = failedPublishSql(table(ctx, "destinations"));
  const lateApproval = "p.status = 'approved' AND p.updated_at < now() - interval '1 day'";
  const rows = await ctx.db.query<{ scheduled: string; approved: string; approved_late: string; failed: string; oldest: string | null }>(
    `SELECT count(*) FILTER (WHERE p.status IN ('scheduled', 'publishing'))::text AS scheduled,
            count(*) FILTER (WHERE p.status = 'approved')::text AS approved,
            count(*) FILTER (WHERE ${lateApproval})::text AS approved_late,
            count(*) FILTER (WHERE ${failed})::text AS failed,
            min(p.updated_at) FILTER (WHERE (${lateApproval}) OR (${failed}))::text AS oldest
       FROM ${table(ctx, "posts")} p WHERE p.company_id = $1`,
    [companyId],
  );
  const r = rows[0];
  const scheduled = count(r?.scheduled);
  const approved = count(r?.approved);
  const approvedLate = count(r?.approved_late);
  const failedPosts = count(r?.failed);
  const reasons = [failedPosts ? `${plural(failedPosts, "post")} failed to publish` : null, approvedLate ? `${plural(approvedLate, "approved post")} with no time for over a day` : null].filter(Boolean);
  const oldest = ageMs(r?.oldest, now);
  return {
    stage: "social.scheduled",
    count: scheduled + approved + failedPosts,
    stuck: failedPosts + approvedLate,
    stuckReason: reasons.length ? reasons.join("; ") : null,
    oldestDays: failedPosts + approvedLate > 0 && oldest != null ? days(oldest) : null,
  };
}

/** The Social stages of the company graph; a stage whose numbers failed to load reports nothing. */
export async function socialFlows(ctx: PluginContext, companyId: string, now = new Date()): Promise<FlowStageReport[]> {
  const drafts = await part(ctx, "flow:drafts", async () => draftsFlow(await draftWork(ctx, companyId), now), null as FlowStageReport | null);
  const approval = await part(ctx, "flow:approval", () => approvalFlow(ctx, companyId, now), null as FlowStageReport | null);
  const scheduled = await part(ctx, "flow:scheduled", () => scheduledFlow(ctx, companyId, now), null as FlowStageReport | null);
  return cleanFlowReports(PLUGIN_ID, [drafts, approval, scheduled].filter((f): f is FlowStageReport => f !== null));
}

// ── snapshot ────────────────────────────────────────────────────────────────

/** The Social agent role for the Cockpit's team (the Cockpit shares it in `roles.updated`). */
export async function teamReport(ctx: PluginContext, companyId: string, agentId: string | null): Promise<TeamMemberReport[]> {
  let status: string | null = null;
  if (agentId) {
    try {
      status = (await ctx.agents.get(agentId, companyId))?.status ?? null;
    } catch {
      status = null;
    }
  }
  return [{ role: "social", agentId, status }];
}

export async function cockpitSnapshot(ctx: PluginContext, companyId: string): Promise<CockpitSnapshot> {
  const snap = emptySnapshot(PLUGIN_ID, "Social");
  const agentId = await part(ctx, "agent", () => linkedAgentId(ctx, companyId, SOCIAL_HIRE_ROLE, legacySocialAgent(ctx)), null);
  snap.kpis = await part(ctx, "kpis", () => kpis(ctx, companyId), [] as CockpitKpi[]);
  snap.health = await part(ctx, "health", () => healthChecks(ctx, companyId, agentId), [] as HealthCheck[]);
  snap.waiting = await part(ctx, "waiting", () => waitingItems(ctx, companyId), [] as WaitingItem[]);
  snap.activity = await part(ctx, "activity", () => activityItems(ctx, companyId), [] as ActivityItem[]);
  snap.quality = await part(ctx, "quality", () => qualityMetrics(ctx, companyId, agentId), [] as QualityMetric[]);
  snap.team = await part(ctx, "team", () => teamReport(ctx, companyId, agentId), [{ role: "social" as const, agentId, status: null }]);
  snap.flows = await socialFlows(ctx, companyId);
  return snap;
}

/**
 * Hourly (refresh-tokens job, next to the setup status): push each company's
 * snapshot and queue any recent lead that missed the outbox. Skips companies
 * whose Social module is off or whose settings were never saved.
 */
export async function publishCockpitSnapshots(ctx: PluginContext): Promise<{ published: number; skipped: number; leads: number }> {
  const result = { published: 0, skipped: 0, leads: 0 };
  for (const companyId of await knownCompanies(ctx)) {
    try {
      if (!(await socialOn(ctx, companyId)) || !(await loadSocialConfig(ctx, companyId)).saved) {
        result.skipped += 1;
        continue;
      }
      await publishCockpitSnapshot(ctx, companyId, await cockpitSnapshot(ctx, companyId));
      result.published += 1;
      result.leads += await part(ctx, "leads", () => enqueueRecentLeads(ctx, companyId), 0);
    } catch (error) {
      result.skipped += 1;
      ctx.logger.info("Social cockpit snapshot skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
