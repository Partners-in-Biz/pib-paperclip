/**
 * What approval does to a post's time.
 *
 * A draft carries a proposed publish time (`scheduled_at` while it is in
 * draft or review). When a person approves it:
 * - the time is still ahead and every destination passes `validate-post` →
 *   the post goes straight to `scheduled` at that time;
 * - otherwise (no time, the time has passed, or a destination fails) it stays
 *   `approved` and the Social agent gets a task to pick a time: one open
 *   "Schedule approved social posts" issue per scope, with a comment (and a
 *   wake-up) for each post added later.
 * The Cockpit lists approved posts without a time as waiting.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { clientPrefix, formatClientParam, scopeOfRow } from "./clients.js";
import { loadSocialConfig } from "./config.js";
import { getPost, iso, setPostScheduleIssue, setPostStatus, type PostRow } from "./db.js";
import { clip } from "./domain.js";
import { createIssueSafely, ORIGIN_KIND, scopeLine, SOCIAL_ORIGINS, socialAssignee, socialProjectId } from "./issues.js";
import { socialPath } from "./oauth/flow.js";

/** A proposed time must be at least this far ahead to be kept on approval. */
export const MIN_LEAD_MS = 2 * 60_000;

export type ScheduleReason = "no_time" | "time_passed" | "invalid";

export interface ApprovalOutcome {
  /** True when approval moved the post to `scheduled`. */
  scheduled: boolean;
  scheduledAt: string | null;
  /** Why it was not scheduled (then `issueId` is the agent's task). */
  reason?: ScheduleReason;
  problems?: string[];
  issueId?: string | null;
  /** One line for the person who approved. */
  message: string;
  /** The note left on the Reviewer's issue. */
  note: string;
}

const OPEN = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopeKey(post: Pick<PostRow, "client_kind" | "client_ref" | "client_name">): string {
  const scope = scopeOfRow(post);
  return scope ? formatClientParam(scope) : "own";
}

function taskState(companyId: string, key: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace: "social-schedule", stateKey: `task:${key}` };
}

/** "Mon 5 Oct, 07:30" in the company's time zone (ISO when the zone is unknown). Pure. */
export function whenText(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-ZA", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
  } catch {
    return value;
  }
}

/** Plain words for a reason, for the post's line on the task. Pure. */
export function reasonText(reason: ScheduleReason, input: { proposed: string | null; problems?: string[] }): string {
  if (reason === "time_passed") return `its proposed time (${input.proposed}) had passed when it was approved`;
  if (reason === "invalid") return `a destination fails validation: ${(input.problems ?? []).slice(0, 3).join("; ")}`;
  return "it has no proposed time";
}

/** Whether a proposed time can be kept at approval time. Pure. */
export function keepProposedTime(proposed: string | null, now: Date): boolean {
  if (!proposed) return false;
  const at = Date.parse(proposed);
  return Number.isFinite(at) && at - now.getTime() >= MIN_LEAD_MS;
}

function postLine(post: PostRow, why: string): string {
  return `- "${clip(post.body.replace(/\s+/g, " ").trim(), 90)}" · post id \`${post.id}\` · ${why}`;
}

/** Task text for the Social agent. Pure. */
export function scheduleTaskDescription(post: PostRow, line: string, pagePath: string | null): string {
  return [
    "A person approved these posts, but they have no publish time yet:",
    "",
    line,
    "",
    scopeLine(post),
    "",
    "What to do:",
    "1. `list-posts` (same scope, status approved): every approved post without a time needs one.",
    "2. Pick each time from the scope's playbook (`get-playbook`: days and times that work) and the calendar (`list-posts` status scheduled), then `schedule-post` (or `bulk-schedule`). The content is approved: do not change it.",
    "3. A destination fails `validate-post`: detach it (`detach-destination`) when the other destinations still make sense; otherwise move the post back to draft, fix it and send it for review again.",
    "4. Close this issue with the times you set. More approved posts in this scope are added here as comments.",
    pagePath ? `Posts: [Social → Posts](${pagePath})` : null,
  ].filter((line): line is string => line !== null).join("\n");
}

/**
 * Give an approved post without a usable time to the Social agent: comment
 * on the scope's open task, or open one. Never throws; returns the issue id.
 */
export async function openScheduleTask(ctx: PluginContext, companyId: string, post: PostRow, why: string): Promise<string | null> {
  const key = taskState(companyId, scopeKey(post));
  const line = postLine(post, why);
  try {
    const assignee = await socialAssignee(ctx, companyId, post.owner_user_id);
    let existing: string | null = null;
    try {
      const value = await ctx.state.get(key);
      existing = typeof value === "string" && value ? value : null;
    } catch {
      existing = null;
    }
    if (existing) {
      const issue = await ctx.issues.get(existing, companyId).catch(() => null);
      if (issue && OPEN.has(String(issue.status))) {
        await ctx.issues.createComment(existing, ["Another approved post needs a time:", "", line].join("\n"), companyId);
        if (issue.assigneeAgentId) await wakeIssue(ctx, existing, companyId, "An approved social post needs a time");
        await setPostScheduleIssue(ctx, companyId, post.id, existing);
        return existing;
      }
    }
    const issue = await createIssueSafely(ctx, {
      companyId,
      projectId: await socialProjectId(ctx, companyId),
      title: `${clientPrefix(post)}Schedule approved social posts`,
      description: scheduleTaskDescription(post, line, await socialPath(ctx, companyId, { tab: "posts" }, scopeOfRow(post)).catch(() => null)),
      priority: "medium",
      originKind: ORIGIN_KIND,
      originId: `${SOCIAL_ORIGINS.schedule}${scopeKey(post)}:${post.id}`,
      assigneeAgentId: assignee.assigneeAgentId,
      assigneeUserId: assignee.assigneeUserId,
      wakeReason: "Approved social posts need a time",
    });
    await ctx.state.set(key, issue.id).catch(() => undefined);
    await setPostScheduleIssue(ctx, companyId, post.id, issue.id);
    return issue.id;
  } catch (error) {
    ctx.logger.info("Social schedule task not opened", { postId: post.id, error: errorMessage(error) });
    return null;
  }
}

/**
 * Right after a person approved `postId`: schedule it at its proposed time,
 * or hand it to the Social agent. `validate` is `validatePostRecord` (passed
 * in to avoid an import cycle with service.ts).
 */
export async function scheduleApproved(
  ctx: PluginContext,
  companyId: string,
  postId: string,
  validate: (postId: string) => Promise<{ ok: boolean; problems: string[] }>,
  now: Date = new Date(),
): Promise<ApprovalOutcome> {
  const post = await getPost(ctx, companyId, postId);
  if (!post || post.status !== "approved") {
    return { scheduled: false, scheduledAt: null, message: "Approved.", note: "A person approved the post." };
  }
  const proposed = iso(post.scheduled_at);
  const timezone = proposed ? (await loadSocialConfig(ctx, companyId).catch(() => null))?.timezone ?? "UTC" : "UTC";
  const when = proposed ? `${whenText(proposed, timezone)} (${timezone})` : null;
  let reason: ScheduleReason = proposed ? "time_passed" : "no_time";
  let problems: string[] | undefined;
  if (proposed && keepProposedTime(proposed, now)) {
    const check = await validate(post.id);
    if (check.ok) {
      if (await setPostStatus(ctx, companyId, post.id, ["approved"], "scheduled", proposed)) {
        await setPostScheduleIssue(ctx, companyId, post.id, null).catch(() => undefined);
        return { scheduled: true, scheduledAt: proposed, message: `Approved and scheduled for ${when}.`, note: `A person approved the post. It is scheduled for ${when}.` };
      }
      // Its status changed in the meantime (someone else moved it): leave it as it is now.
      return { scheduled: false, scheduledAt: null, message: "Approved.", note: "A person approved the post." };
    }
    reason = "invalid";
    problems = check.problems;
  }
  const why = reasonText(reason, { proposed: when, problems });
  const issueId = await openScheduleTask(ctx, companyId, post, why);
  const who = issueId ? "The Social agent has a task to pick a time." : "Pick a time on the post.";
  const what = reason === "invalid" ? "Approved, but not scheduled: a destination fails validation." : reason === "time_passed" ? "Approved, but its proposed time has passed." : "Approved. It has no proposed time yet.";
  return {
    scheduled: false,
    scheduledAt: null,
    reason,
    ...(problems ? { problems } : {}),
    issueId,
    message: `${what} ${who}`,
    note: `A person approved the post, but it is not scheduled: ${why}. ${issueId ? "The Social agent has a task to pick a time." : "Someone has to pick a time on the post."}`,
  };
}
