/**
 * Done-checks (kit `runDoneCheck`): when an AGENT marks a sprint task's issue
 * done (origin id `seo:task:<taskId>`), the task must be complete in the
 * sprint's own data: recorded with `complete-task` (evidence), skipped with a
 * reason, or not needed. Otherwise the issue is reopened with what is
 * missing and the agent is woken. A person's close is never checked (that is
 * how the owner approves a sign-off).
 *
 * The worker runs the check inside its one `issue.updated` handler, before
 * the task syncs from the issue, so an early close never marks the task done,
 * never tells Social and never opens a merge task. (A second
 * `registerDoneChecks` subscription would make the host deliver every issue
 * event to this worker twice.)
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { runDoneCheck, type DoneCheckIssue, type DoneCheckOutcome, type DoneCheckResult, type DoneCheckRule } from "@partnersinbiz/pib-plugin-kit";
import { TASK_ORIGIN_PREFIX, taskIdFromOrigin } from "../constants.js";
import * as db from "../db.js";
import { completionBlocker } from "../engine/guards.js";
import { needsSignoff, type AutopilotMode } from "../engine/sprint.js";
import { playbookFor } from "../templates/playbooks.js";
import { groupBlockerFor } from "./chunks.js";

export const TASK_CHECK_LABEL = "SEO sprint task";

const FINISHED = new Set(["done", "skipped", "na"]);

/** "The content row id, …" → "the content row id, …" (keeps "URL", "LCP/CLS"), without the full stop. */
function inline(text: string): string {
  const trimmed = text.trim().replace(/\.$/, "");
  return /^[A-Z][a-z]/.test(trimmed) ? `${trimmed[0]!.toLowerCase()}${trimmed.slice(1)}` : trimmed;
}

/**
 * What a task issue an agent closed still misses. Pure. Done when the task
 * is gone or moved to another issue, or it is complete in the sprint data:
 * done (recorded with `complete-task`), skipped with a reason, or not needed.
 */
export function taskCloseResult(
  task: Pick<db.SprintTask, "id" | "status" | "owner" | "autopilotEligible" | "playbookKey" | "issueId" | "evidence" | "blockerReason"> | null,
  issueId: string,
  input: { mode: AutopilotMode; blocker: string | null },
): DoneCheckResult {
  if (!task) return { done: true };
  // The task now lives on another issue (moved to the site's repo project): this one no longer carries it.
  if (task.issueId && task.issueId !== issueId) return { done: true };
  if (FINISHED.has(task.status)) return { done: true };
  const handoff = (task.evidence?.handoff ?? null) as { review?: unknown } | null;
  if (handoff?.review === true) {
    return {
      done: false,
      missing: ["This change waits for the owner's sign-off: only a person approves it, by marking this issue done. Reviewer: comment PASS or CHANGES NEEDED and hand it to the owner."],
    };
  }
  if (needsSignoff(task, input.mode)) {
    return {
      done: false,
      missing: [`This task needs the owner's sign-off (safe mode): prepare it, then call \`block-task\` with \`taskId: "${task.id}"\`, \`review: true\`, a clear \`humanAsk\` and your links. The owner closes it.`],
    };
  }
  const record = `\`complete-task\` (\`taskId: "${task.id}"\`; evidence: ${inline(playbookFor(task.playbookKey).evidence)})`;
  const missing = task.status === "blocked"
    ? [`It still waits on a person (${task.blockerReason ?? "a Needs you item"}): leave it open until that is done, then finish the work and record it with ${record}.`]
    : [`Record the result with ${record}.`];
  if (input.blocker) missing.push(input.blocker);
  return { done: false, missing };
}

/** Rule check: reads only the sprint's own tables. */
export async function checkTaskClose(issue: DoneCheckIssue, ctx: PluginContext): Promise<DoneCheckResult> {
  const taskId = taskIdFromOrigin(issue.originId);
  const task = (taskId ? await db.getTask(ctx.db, issue.companyId, taskId) : null) ?? (await db.getTaskByIssue(ctx.db, issue.companyId, issue.id));
  if (!task) return { done: true };
  const open = !FINISHED.has(task.status);
  const sprint = open ? await db.getSprint(ctx.db, issue.companyId, task.sprintId) : null;
  // The same completion rules `complete-task` applies (w5/w6: social posts linked; keywords; directories; day-90 snapshot).
  // A task split into page groups is complete only after the last group (service/chunks.ts).
  const blocker = open ? (completionBlocker(task.taskType, await db.completionFacts(ctx.db, task.sprintId), task.templateKey) ?? (await groupBlockerFor(ctx.db, issue.companyId, task))) : null;
  return taskCloseResult(task, issue.id, { mode: sprint?.autopilotMode ?? "safe", blocker });
}

export const SEO_DONE_CHECKS: DoneCheckRule[] = [{ originPrefix: TASK_ORIGIN_PREFIX, label: TASK_CHECK_LABEL, check: checkTaskClose }];

/**
 * Runs the done-check for one `issue.updated` event. Returns true when the
 * issue was reopened (or handed to the Operator), so the caller skips the
 * task sync for this event. Never throws.
 */
export async function checkAgentClose(ctx: PluginContext, event: Pick<PluginEvent, "entityId" | "companyId" | "actorType">): Promise<boolean> {
  if (event.actorType !== "agent" || !event.entityId || !event.companyId) return false;
  let outcome: DoneCheckOutcome = "skipped";
  try {
    // Only sprint task issues are checked: one cheap lookup spares the host read for every other issue in the company.
    if (!(await db.getTaskByIssue(ctx.db, event.companyId, event.entityId))) return false;
    outcome = await runDoneCheck(ctx, SEO_DONE_CHECKS, event);
  } catch (error) {
    ctx.logger.info("SEO done check failed", { issueId: event.entityId, error: error instanceof Error ? error.message : String(error) });
  }
  return outcome === "reopened" || outcome === "escalated";
}
