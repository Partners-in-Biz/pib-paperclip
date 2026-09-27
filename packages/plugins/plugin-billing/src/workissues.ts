/**
 * Standing work issues: one Paperclip issue per purpose and key ("Drafts to
 * send" per company, "Overdue invoices" per company, one reply issue per
 * quote, one drafting issue per won deal). A run updates the same issue
 * instead of opening another, reopens it when work comes back after it was
 * closed, and closes it when there is nothing left.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue, PIB_PLUGINS, wakeIssue, type WorkRoute } from "@partnersinbiz/pib-plugin-kit";
import { table } from "./db.js";
import { assigneeOf } from "./routing.js";

export interface WorkIssueRow {
  key: string;
  company_id: string;
  kind: string;
  subject_id: string | null;
  issue_id: string;
  fingerprint: string | null;
  status: "open" | "closed";
}

const CLOSED = new Set(["done", "cancelled"]);

export async function getWorkIssue(ctx: PluginContext, key: string): Promise<WorkIssueRow | null> {
  const rows = await ctx.db.query<WorkIssueRow>(
    `SELECT key, company_id, kind, subject_id, issue_id, fingerprint, status FROM ${table(ctx, "work_issues")} WHERE key = $1`,
    [key],
  );
  return rows[0] ?? null;
}

/** Open standing issues for a company, optionally of one kind (for the page). */
export async function openWorkIssues(ctx: PluginContext, companyId: string, kind?: string): Promise<WorkIssueRow[]> {
  return kind
    ? ctx.db.query<WorkIssueRow>(
        `SELECT key, company_id, kind, subject_id, issue_id, fingerprint, status FROM ${table(ctx, "work_issues")} WHERE company_id = $1 AND kind = $2 AND status = 'open' ORDER BY updated_at DESC LIMIT 50`,
        [companyId, kind],
      )
    : ctx.db.query<WorkIssueRow>(
        `SELECT key, company_id, kind, subject_id, issue_id, fingerprint, status FROM ${table(ctx, "work_issues")} WHERE company_id = $1 AND status = 'open' ORDER BY updated_at DESC LIMIT 50`,
        [companyId],
      );
}

export interface StandingIssueInput {
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

async function saveRow(ctx: PluginContext, input: StandingIssueInput, issueId: string): Promise<void> {
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "work_issues")} (key, company_id, kind, subject_id, issue_id, fingerprint, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open')
     ON CONFLICT (key) DO UPDATE SET issue_id = EXCLUDED.issue_id, fingerprint = EXCLUDED.fingerprint, status = 'open', updated_at = now()`,
    [input.key, input.companyId, input.kind, input.subjectId ?? null, issueId, input.fingerprint],
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
    await saveRow(ctx, input, issue.id);
    return { issueId: issue.id, created: true, reopened: false, updated: false };
  }
  const reopen = CLOSED.has(String(existing.status));
  if (reopen && input.reopen === false) return { issueId: existing.id, created: false, reopened: false, updated: false, skipped: true };
  const changed = row.fingerprint !== input.fingerprint || existing.title !== input.title || (existing.description ?? "") !== input.description;
  // Follow the route (e.g. an Account Manager was hired), but never unassign when nobody is available.
  const routed = Boolean(input.route.assigneeAgentId || input.route.assigneeUserId);
  const reassign = routed && ((input.route.assigneeAgentId ?? null) !== (existing.assigneeAgentId ?? null) || (input.route.assigneeUserId ?? null) !== (existing.assigneeUserId ?? null));
  if (reopen || changed || reassign) {
    await ctx.issues.update(
      existing.id,
      {
        title: input.title,
        description: input.description,
        ...(reopen ? { status: "todo" as const } : {}),
        ...(reassign ? { assigneeAgentId: input.route.assigneeAgentId ?? null, assigneeUserId: input.route.assigneeUserId ?? null } : {}),
      },
      input.companyId,
    );
  }
  if (reopen || (changed && input.wake)) await comment(ctx, existing.id, input.companyId, input.comment);
  // Wake the agent for new work, a reopened issue or a new owner; a plain refresh stays quiet.
  if (input.route.assigneeAgentId && (reopen || reassign || (changed && input.wake))) {
    await wakeIssue(ctx, existing.id, input.companyId, input.wakeReason ?? "Billing work updated");
  }
  await saveRow(ctx, input, existing.id);
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
