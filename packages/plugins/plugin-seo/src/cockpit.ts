/**
 * SEO snapshot for the Company Cockpit (`GET /cockpit` and the hourly
 * `cockpit.snapshot` event, kit cockpit.ts). Read-only and cheap: a few
 * SELECTs on our own tables plus kit job/state reads. No Google, Bing or
 * PageSpeed calls and no secret resolves. Every part is wrapped so one
 * failing query never breaks the snapshot.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  configSaved,
  decisionStats,
  emptySnapshot,
  jobHealth,
  linkedAgentId,
  publishCockpitSnapshot,
  readConfig,
  type ActivityItem,
  type CockpitKpi,
  type CockpitSnapshot,
  type HealthCheck,
  type QualityMetric,
  type Tone,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit";
import { DAILY_JOB_KEY, WEEKLY_JOB_KEY } from "./constants.js";
import { t } from "./db.js";
import type { NeedsYouItem } from "./engine/needs-you.js";
import { sprintPagePath } from "./engine/scope.js";
import { PLUGIN_ID } from "./namespace.js";
import type { Env } from "./service/common.js";
import { reemitRecentContent } from "./service/handoff.js";
import { SEO_ROLE } from "./service/hire.js";
import { seoOn } from "./service/setup-status.js";

type Scoped = { sprint_id: string; site_name: string; client_kind: string | null; client_ref: string | null; client_name: string | null };

const RUNNING = "('pre_launch', 'active', 'compounding')";
const STALE_NEEDS_YOU_DAYS = 7;

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function clip(value: string, max: number): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

function prefix(row: Pick<Scoped, "client_name" | "client_ref">): string {
  return row.client_ref ? `[${row.client_name ?? row.client_ref}] ` : "";
}

/** The sprint's SEO page, in its scope (`&client=` for client sprints). */
export function sprintHref(row: Pick<Scoped, "sprint_id" | "client_kind" | "client_ref">, tab?: string): string {
  const scope = row.client_ref ? { kind: row.client_kind === "contact" ? ("contact" as const) : ("company" as const), id: row.client_ref } : null;
  return sprintPagePath("/seo", row.sprint_id, scope, tab ? { tab } : {});
}

export function healthTone(score: number): Tone {
  return score >= 70 ? "ok" : score >= 40 ? "warn" : "bad";
}

async function part<T>(ctx: PluginContext, label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (error) {
    ctx.logger.info("SEO cockpit part failed", { part: label, error: error instanceof Error ? error.message : String(error) });
    return fallback;
  }
}

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

interface SprintRow extends Scoped {
  status: string;
  current_day: number | null;
  health: unknown;
  autopilot_mode: string;
}

async function runningSprints(ctx: PluginContext, companyId: string): Promise<SprintRow[]> {
  return ctx.db.query<SprintRow>(
    `SELECT id AS sprint_id, site_name, client_kind, client_ref, client_name, status, current_day, health, autopilot_mode
       FROM ${t("sprints")} WHERE company_id = $1 AND status IN ${RUNNING} AND seeded_at IS NOT NULL ORDER BY created_at`,
    [companyId],
  );
}

// ── KPIs ────────────────────────────────────────────────────────────────────

export function sprintDayLabel(days: number[]): string | null {
  const known = days.filter((d) => Number.isFinite(d));
  if (known.length === 0) return null;
  const fmt = (d: number) => (d < 0 ? `starts in ${-d}d` : `day ${d}/90`);
  if (known.length === 1) return fmt(known[0]!).replace(/^d/, "D").replace(/^s/, "S");
  const min = Math.min(...known);
  const max = Math.max(...known);
  return min === max ? fmt(min) : `days ${Math.max(min, 0)}–${max} of 90`;
}

async function kpis(ctx: PluginContext, companyId: string, sprints: SprintRow[]): Promise<CockpitKpi[]> {
  const rows = await ctx.db.query<Record<string, string | null>>(
    `SELECT
       (SELECT count(*) FROM ${t("sprint_tasks")} WHERE company_id = $1 AND status = 'done' AND completed_at >= now() - interval '7 days')::text AS done_7d,
       (SELECT count(*) FROM ${t("sprint_tasks")} k JOIN ${t("sprints")} s ON s.id = k.sprint_id
          WHERE k.company_id = $1 AND s.status IN ${RUNNING} AND k.status IN ('not_started', 'in_progress')
            AND COALESCE(k.due_day, 0) < COALESCE(s.current_day, 0))::text AS overdue,
       (SELECT count(*) FROM ${t("keywords")} w JOIN ${t("sprints")} s ON s.id = w.sprint_id
          WHERE w.company_id = $1 AND s.status IN ${RUNNING} AND w.retired_at IS NULL AND w.current_position > 0 AND w.current_position <= 10)::text AS top10,
       (SELECT count(*) FROM ${t("keywords")} w JOIN ${t("sprints")} s ON s.id = w.sprint_id
          WHERE w.company_id = $1 AND s.status IN ${RUNNING} AND w.retired_at IS NULL)::text AS tracked,
       (SELECT sum((i.stats->'siteTotals'->>'clicks')::numeric) FROM ${t("integrations")} i JOIN ${t("sprints")} s ON s.id = i.sprint_id
          WHERE i.company_id = $1 AND s.status IN ${RUNNING} AND i.provider = 'gsc' AND i.stats->'siteTotals'->>'clicks' IS NOT NULL
            AND i.last_pull_at >= now() - interval '3 days')::text AS clicks`,
    [companyId],
  );
  const r = rows[0] ?? {};
  const done = count(r.done_7d);
  const overdue = count(r.overdue);
  const top10 = count(r.top10);
  const tracked = count(r.tracked);
  const out: CockpitKpi[] = [
    {
      key: "seo_active_sprints",
      label: "Active SEO sprints",
      value: String(sprints.length),
      raw: sprints.length,
      tone: "neutral",
      delta: sprintDayLabel(sprints.map((s) => (s.current_day == null ? Number.NaN : s.current_day))),
      href: "/seo",
      group: "marketing",
    },
    { key: "seo_tasks_done_7d", label: "SEO tasks done (7 days)", value: String(done), raw: done, tone: sprints.length > 0 && done === 0 ? "warn" : "neutral", href: "/seo", group: "marketing" },
    { key: "seo_overdue_tasks", label: "Overdue SEO tasks", value: String(overdue), raw: overdue, tone: overdue > 10 ? "bad" : overdue > 0 ? "warn" : "ok", href: "/seo", group: "marketing" },
    { key: "seo_keywords_top10", label: "Keywords in the top 10", value: String(top10), raw: top10, tone: "neutral", delta: tracked ? `of ${tracked} tracked` : null, href: "/seo", group: "marketing" },
  ];
  if (r.clicks != null) {
    const clicks = Math.round(count(r.clicks));
    out.push({ key: "seo_clicks", label: "Search clicks (last 8 days, Search Console)", value: clicks.toLocaleString("en-US"), raw: clicks, tone: "neutral", href: "/seo", group: "marketing" });
  }
  const scores = sprints.map((s) => json<{ score?: unknown }>(s.health, {}).score).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (scores.length > 0) {
    const score = Math.round(Math.min(...scores));
    out.push({ key: "seo_health_score", label: scores.length > 1 ? "SEO health (lowest sprint)" : "SEO health", value: `${score}/100`, raw: score, tone: healthTone(score), href: "/seo", group: "marketing" });
  }
  return out;
}

// ── health ──────────────────────────────────────────────────────────────────

interface IntegrationRow extends Scoped {
  provider: string;
  status: string;
  last_error: string | null;
  last_pull_at: string | null;
  updated_at: string | null;
}

export function integrationChecks(rows: IntegrationRow[]): HealthCheck[] {
  const checks: HealthCheck[] = [];
  for (const row of rows) {
    const where = `${prefix(row)}${row.site_name}`;
    const href = sprintHref(row, "integrations");
    if (row.provider === "gsc") {
      if (row.status === "needs_reconnect" || row.status === "error" || row.last_error) {
        checks.push({
          key: `gsc:${row.sprint_id}`,
          title: `Search Console pull failing: ${where}`,
          status: "bad",
          detail: row.last_error ? clip(row.last_error, 300) : `Connection status: ${row.status.replace("_", " ")}.`,
          href,
          fix: "Check the service account has access to the property (or reconnect Search Console) on the sprint's Integrations tab.",
          since: row.updated_at,
        });
      } else {
        checks.push({
          key: `gsc:${row.sprint_id}`,
          title: `Search Console data is old: ${where}`,
          status: "warn",
          detail: row.last_pull_at ? `Last pull ${row.last_pull_at.slice(0, 10)}.` : "No pull yet.",
          href,
          fix: "The daily run pulls it each morning; check the daily SEO job and the service account.",
          since: row.last_pull_at,
        });
      }
    } else {
      checks.push({
        key: `${row.provider}:${row.sprint_id}`,
        title: `${row.provider === "bing" ? "Bing" : "PageSpeed"} errors: ${where}`,
        status: "warn",
        detail: clip(row.last_error ?? "Error", 300),
        href,
        fix: row.provider === "bing" ? "Check the Bing Webmaster API key in the SEO settings." : "Add or check the PageSpeed API key in the SEO settings (quota errors clear on their own).",
        since: row.updated_at,
      });
    }
  }
  return checks;
}

/** Open Needs you items waiting longer than a week, per sprint. Pure. */
export function staleNeedsYou(digests: Array<Scoped & { items: unknown }>, now: Date): HealthCheck[] {
  const cutoff = now.getTime() - STALE_NEEDS_YOU_DAYS * 24 * 3600_000;
  const out: HealthCheck[] = [];
  for (const d of digests) {
    const stale = json<NeedsYouItem[]>(d.items, []).filter((i) => i.status === "open" && !i.optional && Date.parse(i.addedAt) < cutoff);
    if (stale.length === 0) continue;
    const oldest = stale.map((i) => i.addedAt).sort()[0] ?? null;
    out.push({
      key: `needs-you:${d.sprint_id}`,
      title: `Needs you items waiting over a week: ${prefix(d)}${d.site_name}`,
      status: "warn",
      detail: `${plural(stale.length, "item")}: ${stale.slice(0, 3).map((i) => i.title).join("; ")}${stale.length > 3 ? "…" : ""}`,
      href: sprintHref(d, "integrations"),
      fix: "Do the steps on the sprint's Needs you issue, or mark an item done when it is.",
      since: oldest,
    });
  }
  return out;
}

async function healthChecks(ctx: PluginContext, companyId: string, sprints: SprintRow[]): Promise<HealthCheck[]> {
  const checks: HealthCheck[] = [
    await part(ctx, "job:daily", () => jobHealth(ctx, DAILY_JOB_KEY, "Daily SEO run", 60), { key: `job:${DAILY_JOB_KEY}`, title: "Daily SEO run", status: "ok" as const }),
    await part(ctx, "job:weekly", () => jobHealth(ctx, WEEKLY_JOB_KEY, "Weekly SEO review", 7 * 24 * 60), { key: `job:${WEEKLY_JOB_KEY}`, title: "Weekly SEO review", status: "ok" as const }),
  ];
  if (sprints.length === 0) return checks;
  const integrations = await part(
    ctx,
    "integrations",
    () =>
      ctx.db.query<IntegrationRow>(
        `SELECT i.provider, i.status, i.last_error, i.last_pull_at::text AS last_pull_at, i.updated_at::text AS updated_at,
                s.id AS sprint_id, s.site_name, s.client_kind, s.client_ref, s.client_name
           FROM ${t("integrations")} i JOIN ${t("sprints")} s ON s.id = i.sprint_id
          WHERE i.company_id = $1 AND s.status IN ${RUNNING}
            AND ((i.provider = 'gsc' AND (i.status IN ('needs_reconnect', 'error') OR (i.status = 'connected' AND (i.last_error IS NOT NULL OR i.last_pull_at IS NULL OR i.last_pull_at < now() - interval '3 days'))))
                 OR (i.provider IN ('bing', 'pagespeed') AND i.status = 'enabled' AND i.last_error IS NOT NULL))
          ORDER BY s.created_at LIMIT 30`,
        [companyId],
      ),
    [] as IntegrationRow[],
  );
  checks.push(...integrationChecks(integrations));
  if (!integrations.some((i) => i.provider === "gsc")) checks.push({ key: "gsc", title: "Search Console pulls", status: "ok" });

  // Service account: configured in the settings (checked without resolving the secret).
  const config = await part(ctx, "config", () => readConfig(ctx, companyId), {} as Record<string, unknown>);
  const google = (config.google && typeof config.google === "object" ? config.google : {}) as Record<string, unknown>;
  const connected = await part(
    ctx,
    "gsc-connected",
    async () => {
      const rows = await ctx.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${t("integrations")} i JOIN ${t("sprints")} s ON s.id = i.sprint_id
          WHERE i.company_id = $1 AND s.status IN ${RUNNING} AND i.provider = 'gsc' AND i.status = 'connected' AND i.property_url IS NOT NULL`,
        [companyId],
      );
      return count(rows[0]?.n);
    },
    0,
  );
  if (!google.serviceAccountJson && connected < sprints.length) {
    checks.push({
      key: "service-account",
      title: "Google service account not set",
      status: "warn",
      detail: `${plural(sprints.length - connected, "running sprint")} without Search Console data. The agent verifies sites and pulls rankings through the service account.`,
      href: "/company/settings/instance/plugins",
      fix: "Add the service account JSON key in the SEO plugin settings (Google → Service account).",
    });
  } else {
    checks.push({ key: "service-account", title: "Google service account", status: "ok" });
  }

  const digests = await part(
    ctx,
    "needs-you",
    () =>
      ctx.db.query<Scoped & { items: unknown }>(
        `SELECT n.items, s.id AS sprint_id, s.site_name, s.client_kind, s.client_ref, s.client_name
           FROM ${t("needs_you")} n JOIN ${t("sprints")} s ON s.id = n.sprint_id
          WHERE n.company_id = $1 AND n.status = 'open' AND s.status IN ${RUNNING} ORDER BY n.week_start DESC LIMIT 30`,
        [companyId],
      ),
    [] as Array<Scoped & { items: unknown }>,
  );
  checks.push(...staleNeedsYou(digests, new Date()));
  return checks;
}

// ── waiting ─────────────────────────────────────────────────────────────────

const KIND: Record<NeedsYouItem["kind"], WaitingItem["kind"]> = {
  grant: "grant",
  review: "review",
  pr: "review",
  message: "judgement",
  task: "other",
  indexing: "other",
};

async function waitingItems(ctx: PluginContext, companyId: string): Promise<WaitingItem[]> {
  const items: WaitingItem[] = [];
  const digests = await ctx.db.query<Scoped & { items: unknown; issue_id: string | null }>(
    `SELECT n.items, n.issue_id, s.id AS sprint_id, s.site_name, s.client_kind, s.client_ref, s.client_name
       FROM ${t("needs_you")} n JOIN ${t("sprints")} s ON s.id = n.sprint_id
      WHERE n.company_id = $1 AND n.status = 'open' AND s.status <> 'archived' ORDER BY n.week_start DESC LIMIT 30`,
    [companyId],
  );
  const seen = new Set<string>();
  const pending: Array<{ item: NeedsYouItem; digest: (typeof digests)[number] }> = [];
  for (const digest of digests) {
    for (const item of json<NeedsYouItem[]>(digest.items, [])) {
      const key = `seo:needs-you:${digest.sprint_id}:${item.key}`;
      if (item.status !== "open" || item.optional || seen.has(key)) continue;
      seen.add(key);
      pending.push({ item, digest });
    }
  }
  // Sign-offs are approved on the task's own issue (the owner marks it done).
  const reviewTaskIds = pending.filter((p) => p.item.kind === "review" && p.item.taskIds?.length === 1).map((p) => p.item.taskIds![0]!);
  const taskIssues = new Map<string, string>();
  if (reviewTaskIds.length > 0) {
    const rows = await ctx.db.query<{ id: string; issue_id: string | null }>(
      `SELECT id, issue_id FROM ${t("sprint_tasks")} WHERE company_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
      [companyId, JSON.stringify(reviewTaskIds)],
    );
    for (const row of rows) if (row.issue_id) taskIssues.set(row.id, row.issue_id);
  }
  for (const { item, digest } of pending) {
    const taskIssue = item.kind === "review" && item.taskIds?.length === 1 ? taskIssues.get(item.taskIds[0]!) ?? null : null;
    items.push({
      key: `seo:needs-you:${digest.sprint_id}:${item.key}`,
      title: `${prefix(digest)}${item.title}`,
      why: clip(item.why || "Only a person can do this for the SEO sprint.", 300),
      href: sprintHref(digest, "integrations"),
      issueId: taskIssue ?? digest.issue_id,
      kind: KIND[item.kind] ?? "other",
      since: item.addedAt ?? null,
    });
  }
  const proposals = await ctx.db.query<Scoped & { id: string; subject: string; proposed_action: string; approval_issue_id: string | null; created_at: string | null }>(
    `SELECT o.id, o.subject, o.proposed_action, o.approval_issue_id, o.created_at::text AS created_at,
            s.id AS sprint_id, s.site_name, s.client_kind, s.client_ref, s.client_name
       FROM ${t("optimizations")} o JOIN ${t("sprints")} s ON s.id = o.sprint_id
      WHERE o.company_id = $1 AND o.status = 'proposed' AND s.autopilot_mode <> 'full' AND s.status IN ${RUNNING}
      ORDER BY o.created_at LIMIT 20`,
    [companyId],
  );
  for (const p of proposals) {
    items.push({
      key: `seo:optimization:${p.id}`,
      title: `${prefix(p)}Approve an SEO change: ${clip(p.subject, 80)}`,
      why: clip(`In safe autopilot the owner approves each optimization. Proposed: ${p.proposed_action}`, 300),
      href: sprintHref(p, "optimizations"),
      issueId: p.approval_issue_id,
      kind: "judgement",
      since: p.created_at,
    });
  }
  return items;
}

// ── activity ────────────────────────────────────────────────────────────────

async function activityItems(ctx: PluginContext, companyId: string): Promise<ActivityItem[]> {
  const out: ActivityItem[] = [];
  const tasks = await ctx.db.query<Scoped & { title: string; completed_at: string; completed_by: string | null; by_kind: string | null; links: unknown }>(
    `SELECT k.title, k.completed_at::text AS completed_at, k.completed_by, k.evidence->>'byKind' AS by_kind, k.evidence->'links' AS links,
            s.id AS sprint_id, s.site_name, s.client_kind, s.client_ref, s.client_name
       FROM ${t("sprint_tasks")} k JOIN ${t("sprints")} s ON s.id = k.sprint_id
      WHERE k.company_id = $1 AND k.status = 'done' AND k.completed_at IS NOT NULL ORDER BY k.completed_at DESC LIMIT 10`,
    [companyId],
  );
  for (const task of tasks) {
    const merged = /^Merge the approved PR: /.test(task.title);
    const pr = json<unknown[]>(task.links, []).some((l) => typeof l === "string" && /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(l));
    out.push({
      at: task.completed_at,
      text: merged
        ? `${prefix(task)}Merged the approved PR for "${clip(task.title.replace(/^Merge the approved PR: /, ""), 60)}" (${task.site_name})`
        : `${prefix(task)}Completed "${clip(task.title, 60)}"${pr ? " with a PR" : ""} (${task.site_name})`,
      href: sprintHref(task),
      agentId: task.by_kind === "agent" ? task.completed_by : null,
    });
  }
  const measured = await ctx.db.query<Scoped & { subject: string; result: string | null; measured_at: string }>(
    `SELECT o.subject, o.result, o.measured_at::text AS measured_at, s.id AS sprint_id, s.site_name, s.client_kind, s.client_ref, s.client_name
       FROM ${t("optimizations")} o JOIN ${t("sprints")} s ON s.id = o.sprint_id
      WHERE o.company_id = $1 AND o.measured_at IS NOT NULL ORDER BY o.measured_at DESC LIMIT 5`,
    [companyId],
  );
  for (const m of measured) {
    out.push({ at: m.measured_at, text: `${prefix(m)}Measured "${clip(m.subject, 60)}": ${(m.result ?? "inconclusive").replace("_", " ")}`, href: sprintHref(m, "optimizations") });
  }
  const live = await ctx.db.query<Scoped & { title: string; target_url: string | null; at: string }>(
    `SELECT c.title, c.target_url, COALESCE(c.published_on::text || 'T00:00:00Z', c.updated_at::text) AS at,
            s.id AS sprint_id, s.site_name, s.client_kind, s.client_ref, s.client_name
       FROM ${t("content")} c JOIN ${t("sprints")} s ON s.id = c.sprint_id
      WHERE c.company_id = $1 AND c.status = 'live' ORDER BY c.published_on DESC NULLS LAST, c.updated_at DESC LIMIT 5`,
    [companyId],
  );
  for (const c of live) out.push({ at: c.at, text: `${prefix(c)}Published "${clip(c.title, 60)}"`, href: c.target_url ?? sprintHref(c) });
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 10);
}

// ── quality ─────────────────────────────────────────────────────────────────

async function qualityMetrics(ctx: PluginContext, companyId: string, agentId: string | null): Promise<QualityMetric[]> {
  const rows = await ctx.db.query<Record<string, string | null>>(
    `SELECT
       (SELECT count(*) FROM ${t("optimizations")} WHERE company_id = $1 AND result = 'win' AND measured_at >= now() - interval '90 days')::text AS wins,
       (SELECT count(*) FROM ${t("optimizations")} WHERE company_id = $1 AND result = 'loss' AND measured_at >= now() - interval '90 days')::text AS losses,
       (SELECT count(*) FROM ${t("optimizations")} WHERE company_id = $1 AND result IS NOT NULL AND measured_at >= now() - interval '90 days')::text AS measured,
       (SELECT count(*) FROM ${t("sprint_tasks")} WHERE company_id = $1
          AND ((status IN ('not_started', 'in_progress', 'blocked') AND evidence->>'summary' IS NOT NULL) OR evidence->'previous' IS NOT NULL)
          AND updated_at >= now() - interval '30 days')::text AS reopened,
       (SELECT count(*) FROM ${t("sprint_tasks")} k JOIN ${t("sprints")} s ON s.id = k.sprint_id
          WHERE k.company_id = $1 AND k.status = 'blocked' AND s.status IN ${RUNNING})::text AS blocked`,
    [companyId],
  );
  const r = rows[0] ?? {};
  const wins = count(r.wins);
  const losses = count(r.losses);
  const measured = count(r.measured);
  const reopened = count(r.reopened);
  const blocked = count(r.blocked);
  const out: QualityMetric[] = [
    {
      key: "seo_optimization_win_rate_90d",
      label: "Optimization results (90 days)",
      value: measured > 0 ? `${plural(wins, "win")}, ${plural(losses, "loss", "losses")} of ${measured}` : "—",
      raw: measured > 0 ? Math.round((wins / measured) * 1000) / 1000 : null,
      tone: measured === 0 ? "neutral" : losses > wins ? "warn" : "ok",
      agentId,
    },
    { key: "seo_tasks_reopened_30d", label: "SEO tasks reopened (30 days)", value: String(reopened), raw: reopened, tone: reopened >= 3 ? "warn" : "ok", agentId },
    { key: "seo_tasks_blocked", label: "SEO tasks blocked", value: String(blocked), raw: blocked, tone: blocked > 5 ? "bad" : blocked > 0 ? "warn" : "ok", agentId },
  ];
  const stats = await part(ctx, "decisions", () => decisionStats(ctx, companyId, 30), []);
  const total = stats.reduce((sum, s) => sum + count(s.total), 0);
  if (total > 0) {
    const corrected = stats.reduce((sum, s) => sum + count(s.corrected), 0);
    const rate = corrected / total;
    out.push({ key: "seo_decisions_corrected_30d", label: "Jev decisions corrected by people (30 days)", value: `${corrected} of ${total}`, raw: Math.round(rate * 1000) / 1000, tone: rate > 0.25 ? "bad" : rate > 0.1 ? "warn" : "ok" });
  }
  return out;
}

// ── snapshot ────────────────────────────────────────────────────────────────

export async function cockpitSnapshot(ctx: PluginContext, companyId: string): Promise<CockpitSnapshot> {
  const snap = emptySnapshot(PLUGIN_ID, "SEO");
  const sprints = await part(ctx, "sprints", () => runningSprints(ctx, companyId), [] as SprintRow[]);
  const agentId = await part(ctx, "agent", () => linkedAgentId(ctx, companyId, SEO_ROLE), null);
  snap.kpis = await part(ctx, "kpis", () => kpis(ctx, companyId, sprints), [] as CockpitKpi[]);
  snap.health = await part(ctx, "health", () => healthChecks(ctx, companyId, sprints), [] as HealthCheck[]);
  snap.waiting = await part(ctx, "waiting", () => waitingItems(ctx, companyId), [] as WaitingItem[]);
  snap.activity = await part(ctx, "activity", () => activityItems(ctx, companyId), [] as ActivityItem[]);
  snap.quality = await part(ctx, "quality", () => qualityMetrics(ctx, companyId, agentId), [] as QualityMetric[]);
  return snap;
}

/**
 * Hourly (seo-daily, next to the setup status): push each company's snapshot
 * and re-emit content that went live in the last 24 hours. Skips companies
 * whose SEO module is off or whose settings were never saved.
 */
export async function publishCockpitSnapshots(env: Env, companies: string[]): Promise<{ published: number; skipped: number; content: number }> {
  const result = { published: 0, skipped: 0, content: 0 };
  for (const companyId of companies) {
    try {
      if (!(await seoOn(env, companyId)) || !(await configSaved(env.ctx, companyId))) {
        result.skipped += 1;
        continue;
      }
      await publishCockpitSnapshot(env.ctx, companyId, await cockpitSnapshot(env.ctx, companyId));
      result.published += 1;
      result.content += await part(env.ctx, "content-handoff", () => reemitRecentContent(env, companyId), 0);
    } catch (error) {
      result.skipped += 1;
      env.ctx.logger.info("SEO cockpit snapshot skipped", { companyId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
