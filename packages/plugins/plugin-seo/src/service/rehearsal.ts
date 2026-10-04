/**
 * Archiving a rehearsal sprint (engine/rehearsal.ts): close whatever Paperclip issue it may still have, so a rehearsal leaves
 * nothing open in anyone's queue. Since 0.23.2 a rehearsal sprint is never given an issue, so for a new one this finds none;
 * it matters for a sprint made before that, and as a net under any path that was missed. Best effort: a failed read or
 * update is logged and skipped, and the archive itself has already happened. A real sprint never comes here.
 */
import * as db from "../db.js";
import { TERMINAL_TASK_STATUSES } from "../engine/sprint.js";
import { errorMessage, type Env } from "./common.js";
import { getIssue, OPEN_ISSUE_STATUSES, patchIssue } from "./issues.js";

const NOTE = "Rehearsal sprint archived";

/** Issue ids a build request recorded on the task (evidence.builds[].issueId). */
function buildIssueIds(task: db.SprintTask): string[] {
  const builds = (task.evidence ?? {}).builds;
  if (!Array.isArray(builds)) return [];
  return builds.map((b) => (b && typeof b === "object" ? (b as { issueId?: unknown }).issueId : null)).filter((id): id is string => typeof id === "string" && id.length > 0);
}

export async function cancelRehearsalIssues(env: Env, sprint: db.Sprint): Promise<{ cancelled: number; checked: number }> {
  const companyId = sprint.companyId;
  const skip = (what: string, error: unknown) => env.ctx.logger.info("SEO rehearsal archive: a step was skipped", { sprintId: sprint.id, what, error: errorMessage(error) });
  // The task issues first, the root last: children are closed before the issue they hang under.
  const taskIssues = new Map<string, db.SprintTask[]>();
  const others = new Set<string>();
  try {
    for (const task of await db.listTasks(env.ctx.db, companyId, sprint.id, { limit: 1000 })) {
      if (task.issueId) taskIssues.set(task.issueId, [...(taskIssues.get(task.issueId) ?? []), task]);
      for (const id of buildIssueIds(task)) others.add(id);
    }
  } catch (error) {
    skip("tasks", error);
  }
  const chunkIssues = new Map<string, db.TaskChunk>();
  try {
    for (const chunk of await db.unfinishedChunks(env.ctx.db, companyId, sprint.id)) if (chunk.issueId) chunkIssues.set(chunk.issueId, chunk);
  } catch (error) {
    skip("page groups", error);
  }
  try {
    for (const digest of await db.recentNeedsYouDigests(env.ctx.db, companyId, sprint.id, 26)) if (digest.issueId) others.add(digest.issueId);
  } catch (error) {
    skip("needs you", error);
  }
  try {
    for (const proposal of await db.listOptimizations(env.ctx.db, companyId, sprint.id)) if (proposal.approvalIssueId) others.add(proposal.approvalIssueId);
  } catch (error) {
    skip("proposals", error);
  }
  try {
    const rows = await env.ctx.db.query<{ review_issue_id: string | null }>(
      `SELECT review_issue_id FROM ${db.t("previews")} WHERE company_id = $1 AND sprint_id = $2 AND review_issue_id IS NOT NULL`,
      [companyId, sprint.id],
    );
    for (const row of rows) if (row.review_issue_id) others.add(String(row.review_issue_id));
  } catch (error) {
    skip("preview reviews", error);
  }

  const order = [...chunkIssues.keys(), ...taskIssues.keys(), ...others, ...(sprint.rootIssueId ? [sprint.rootIssueId] : [])];
  const seen = new Set<string>();
  let cancelled = 0;
  let checked = 0;
  for (const issueId of order) {
    if (seen.has(issueId)) continue;
    seen.add(issueId);
    checked += 1;
    const issue = await getIssue(env, companyId, issueId);
    if (!issue || !OPEN_ISSUE_STATUSES.has(String(issue.status))) continue;
    if (!(await patchIssue(env, companyId, issueId, { status: "cancelled" }))) continue;
    cancelled += 1;
    // The rows follow their issue now rather than waiting for the issue event: an open task becomes skipped, as the sync would make it.
    try {
      for (const task of taskIssues.get(issueId) ?? []) {
        const open = !(TERMINAL_TASK_STATUSES as string[]).includes(task.status);
        await db.updateTask(env.ctx.db, companyId, task.id, { issue_status: "cancelled", ...(open ? { status: "skipped", blocker_reason: NOTE, completed_at: env.now().toISOString(), completed_by: "system" } : {}) });
      }
      const chunk = chunkIssues.get(issueId);
      if (chunk) await db.updateChunk(env.ctx.db, companyId, chunk.id, { status: "cancelled", done_at: env.now().toISOString() });
    } catch (error) {
      skip("rows", error);
    }
  }
  return { cancelled, checked };
}
