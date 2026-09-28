/**
 * Standing work issues: one Paperclip issue per purpose and key ("Drafts to
 * send" per company, "Overdue invoices" per company, one reply issue per
 * quote, one drafting issue per won deal). A run updates the same issue
 * instead of opening another, reopens it when work comes back after it was
 * closed, and closes it when there is nothing left.
 *
 * The key is also the issue's origin id (`billing:<kind>:<id>`), which the
 * done checks match on (`donechecks.ts`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue, PIB_PLUGINS, wakeIssue, type WorkRoute } from "@partnersinbiz/pib-plugin-kit";
import { asObject, table } from "./db.js";
import { assigneeOf } from "./routing.js";

export interface WorkIssueRow {
  key: string;
  company_id: string;
  kind: string;
  subject_id: string | null;
  issue_id: string;
  fingerprint: string | null;
  status: "open" | "closed";
  /** When the issue was last created or reopened: done checks count work since then. */
  opened_at?: unknown;
  /** What the issue is about (the client of a won deal, a quote's status when the customer replied). */
  detail?: unknown;
  created_at?: unknown;
}

const CLOSED = new Set(["done", "cancelled"]);
const COLUMNS = "key, company_id, kind, subject_id, issue_id, fingerprint, status, opened_at, detail, created_at";

export async function getWorkIssue(ctx: PluginContext, key: string): Promise<WorkIssueRow | null> {
  const rows = await ctx.db.query<WorkIssueRow>(`SELECT ${COLUMNS} FROM ${table(ctx, "work_issues")} WHERE key = $1`, [key]);
  return rows[0] ?? null;
}

/** The row's `detail` as an object (empty when none). */
export function workDetail(row: Pick<WorkIssueRow, "detail"> | null | undefined): Record<string, unknown> {
  return asObject(row?.detail);
}

/** Open standing issues for a company, optionally of one kind (for the page). */
export async function openWorkIssues(ctx: PluginContext, companyId: string, kind?: string): Promise<WorkIssueRow[]> {
  return kind
    ? ctx.db.query<WorkIssueRow>(
        `SELECT ${COLUMNS} FROM ${table(ctx, "work_issues")} WHERE company_id = $1 AND kind = $2 AND status = 'open' ORDER BY updated_at DESC LIMIT 50`,
        [companyId, kind],
      )
    : ctx.db.query<WorkIssueRow>(
        `SELECT ${COLUMNS} FROM ${table(ctx, "work_issues")} WHERE company_id = $1 AND status = 'open' ORDER BY updated_at DESC LIMIT 50`,
        [companyId],
      );
}

export interface StandingIssueInput {
  /** Stable key, also the issue's origin id: `billing:<kind>:<id>`. */
  key: string;
  companyId: string;
  kind: string;
  subjectId?: string | null;
  title: string;
  description: string;
  /** What the issue lists; a change updates the issue. */
  fingerprint: string;
  route: WorkRoute;
  /** Wake the assignee (an agent) because there is new work, not just a refresh. */
  wake: boolean;
  /** Comment added when the issue is updated with new work or reopened. */
  comment?: string | null;
  wakeReason?: string;
  /** false: leave an issue someone closed alone (only refresh open ones). Default true. */
  reopen?: boolean;
  /** What the issue is about, kept for its done check (replaces the stored detail when given). */
  detail?: Record<string, unknown> | null;
}

export interface StandingIssueResult {
  issueId: string;
  created: boolean;
  reopened: boolean;
  updated: boolean;
  /** The issue was closed and `reopen: false` left it so. */
  skipped?: boolean;
}

async function comment(ctx: PluginContext, issueId: string, companyId: string, body: string | null | undefined): Promise<void> {
  if (!body) return;
  try {
    await ctx.issues.createComment(issueId, body, companyId);
  } catch (error) {
    ctx.logger.info("Work issue comment skipped", { issueId, error: error instanceof Error ? error.message : String(error) });
  }
}

async function saveRow(ctx: PluginContext, input: StandingIssueInput, issueId: string, opened: boolean): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "work_issues")} AS w (key, company_id, kind, subject_id, issue_id, fingerprint, status, opened_at, detail)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now(), $7::jsonb)
     ON CONFLICT (key) DO UPDATE SET issue_id = EXCLUDED.issue_id, fingerprint = EXCLUDED.fingerprint, status = 'open', updated_at = now(),
       opened_at = CASE WHEN $8::boolean THEN now() ELSE COALESCE(w.opened_at, now()) END,
       detail = COALESCE(EXCLUDED.detail, w.detail)`,
    [input.key, input.companyId, input.kind, input.subjectId ?? null, issueId, input.fingerprint, input.detail ? JSON.stringify(input.detail) : null, opened],
  );
}

/** Create the standing issue, or update / reopen the one that exists. */
export async function upsertStandingIssue(ctx: PluginContext, input: StandingIssueInput): Promise<StandingIssueResult> {
  const row = await getWorkIssue(ctx, input.key);
  const existing = row ? await ctx.issues.get(row.issue_id, input.companyId).catch(() => null) : null;
  const assignee = assigneeOf(input.route);
  if (!row || !existing) {
    const issue = await createWorkIssue(ctx, {
      companyId: input.companyId,
      title: input.title,
      description: input.description,
      originKind: `plugin:${PIB_PLUGINS.billing}`,
      originId: input.key,
      ...assignee,
      wakeReason: input.wakeReason,
    });
    await saveRow(ctx, input, issue.id, true);
    return { issueId: issue.id, created: true, reopened: false, updated: false };
  }
  const reopen = CLOSED.has(String(existing.status));
  if (reopen && input.reopen === false) return { issueId: existing.id, created: false, reopened: false, updated: false, skipped: true };
  const changed = row.fingerprint !== input.fingerprint || existing.title !== input.title || (existing.description ?? "") !== input.description;
  // Follow the route (e.g. an Account Manager was hired), but never unassign when nobody is available.
  const routed = Boolean(input.route.assigneeAgentId || input.route.assigneeUserId);
  const reassign = routed && ((input.route.assigneeAgentId ?? null) !== (existing.assigneeAgentId ?? null) || (input.route.assigneeUserId ?? null) !== (existing.assigneeUserId ?? null));
  // Issues opened before 0.5 carry the old origin id: give them the current one so their done check runs.
  const origin = (existing as { originId?: string | null }).originId !== input.key;
  if (reopen || changed || reassign || origin) {
    await ctx.issues.update(
      existing.id,
      {
        title: input.title,
        description: input.description,
        ...(reopen ? { status: "todo" as const } : {}),
        ...(reassign ? { assigneeAgentId: input.route.assigneeAgentId ?? null, assigneeUserId: input.route.assigneeUserId ?? null } : {}),
        ...(origin ? { originId: input.key } : {}),
      },
      input.companyId,
    );
  }
  if (reopen || (changed && input.wake)) await comment(ctx, existing.id, input.companyId, input.comment);
  // Wake the agent for new work, a reopened issue or a new owner; a plain refresh stays quiet.
  if (input.route.assigneeAgentId && (reopen || reassign || (changed && input.wake))) {
    await wakeIssue(ctx, existing.id, input.companyId, input.wakeReason ?? "Billing work updated");
  }
  await saveRow(ctx, input, existing.id, reopen);
  return { issueId: existing.id, created: false, reopened: reopen, updated: changed };
}

/** Close the standing issue (done, with a comment) when there is nothing left to do. */
export async function closeStandingIssue(ctx: PluginContext, key: string, companyId: string, note: string): Promise<boolean> {
  const row = await getWorkIssue(ctx, key);
  if (!row || row.status !== "open") return false;
  const issue = await ctx.issues.get(row.issue_id, companyId).catch(() => null);
  if (issue && !CLOSED.has(String(issue.status))) {
    try {
      await ctx.issues.update(issue.id, { status: "done" }, companyId);
      await comment(ctx, issue.id, companyId, note);
    } catch (error) {
      ctx.logger.info("Work issue not closed", { key, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
  await ctx.db.execute(`UPDATE ${table(ctx, "work_issues")} SET status = 'closed', updated_at = now() WHERE key = $1`, [key]);
  return true;
}

/**
 * Open standing issues made before 0.5 carry the old origin id (`digest:drafts:…`,
 * `quote-reply:…`, `deal-won:…`). Give each the key it is stored under, so its
 * done check runs. Daily; cheap (a few open rows). Returns how many changed.
 */
export async function refreshWorkIssueOrigins(ctx: PluginContext, companyId: string): Promise<number> {
  let changed = 0;
  for (const row of await openWorkIssues(ctx, companyId)) {
    try {
      const issue = await ctx.issues.get(row.issue_id, companyId);
      if (!issue || CLOSED.has(String(issue.status)) || (issue as { originId?: string | null }).originId === row.key) continue;
      await ctx.issues.update(issue.id, { originId: row.key }, companyId);
      changed += 1;
    } catch (error) {
      ctx.logger.info("Work issue origin not updated", { key: row.key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return changed;
}
