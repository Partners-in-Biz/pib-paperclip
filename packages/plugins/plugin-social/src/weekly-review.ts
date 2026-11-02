/**
 * One weekly review issue per person (`Review social posts: week of <Monday>`) instead of one issue per post.
 *
 * When a post waits for a team member's sign-off, `addWeeklyReviewItem` appends it as a checklist item (with its Social page
 * link) to the person's issue for the current week, opening that issue when it is the first. `closeWeeklyReviewItem` ticks the
 * item when the post leaves review (signed off on the Social page, or sent back to draft) and closes the issue when every item
 * is done. Items live in plugin state (the issue text is rebuilt from them); a closed issue is replaced by a fresh one.
 * The Reviewer-agent and Social-agent issues are not touched: they stay one per post (`review:<postId>`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientPrefix, scopeOfRow } from "./clients.js";
import type { PostRow } from "./db.js";
import { clip } from "./domain.js";
import { createIssueSafely, ORIGIN_KIND, projectIdForRow, SOCIAL_ORIGINS } from "./issues.js";
import { socialPath } from "./oauth/flow.js";

export interface WeeklyItem {
  postId: string;
  snippet: string;
  prefix: string;
  link: string | null;
  done: boolean;
}

interface WeeklyState {
  issueId: string;
  userId: string;
  weekOf: string;
  items: WeeklyItem[];
}

const OPEN = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

/** The Monday (UTC) of the week `now` falls in, as YYYY-MM-DD. Pure. */
export function weekStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function weeklyReviewTitle(weekOf: string): string {
  return `Review social posts: week of ${weekOf}`;
}

/** Issue text: the checklist of posts. Pure. */
export function weeklyReviewDescription(items: WeeklyItem[]): string {
  const open = items.filter((i) => !i.done).length;
  return [
    `Social posts waiting for your sign-off this week (${open} of ${items.length} still open). Open each post on the Social page → Posts and click Approve; the item is ticked when you do, and this issue closes when every item is signed off.`,
    "",
    ...items.map((i) => `- [${i.done ? "x" : " "}] ${i.prefix}${i.snippet}${i.link ? ` — [Sign off on the Social page](${i.link})` : ""} (post \`${i.postId}\`)`),
    "",
    "Closing this issue does not approve anything: only the sign-off on the Social page does.",
  ].join("\n");
}

const weekKey = (userId: string, weekOf: string) => ({ scopeKind: "instance" as const, namespace: "social-weekly-review", stateKey: `week:${userId}:${weekOf}` });
const postKey = (postId: string) => ({ scopeKind: "instance" as const, namespace: "social-weekly-review", stateKey: `post:${postId}` });

async function issueIsOpen(ctx: PluginContext, companyId: string, issueId: string): Promise<boolean> {
  const issue = await ctx.issues.get(issueId, companyId);
  return Boolean(issue && OPEN.has(String(issue.status)));
}

/** Appends the post to the person's weekly issue (opening it first when needed). Returns the issue id; throws on a host error. */
export async function addWeeklyReviewItem(ctx: PluginContext, companyId: string, post: PostRow, userId: string, comment: string, now = new Date()): Promise<string> {
  const weekOf = weekStart(now);
  const stored = (await ctx.state.get(weekKey(userId, weekOf))) as WeeklyState | null;
  const item: WeeklyItem = {
    postId: post.id,
    snippet: clip(post.body.replace(/\s+/g, " ").trim(), 60),
    prefix: clientPrefix(post),
    link: await socialPath(ctx, companyId, { tab: "posts" }, scopeOfRow(post)),
    done: false,
  };
  let state: WeeklyState | null = stored && (await issueIsOpen(ctx, companyId, stored.issueId)) ? stored : null;
  if (state) {
    state.items = [...state.items.filter((i) => i.postId !== post.id), item];
    await ctx.issues.update(state.issueId, { description: weeklyReviewDescription(state.items) }, companyId);
    await ctx.issues.createComment(state.issueId, `${item.prefix}${item.snippet}: ${comment}`, companyId);
  } else {
    // A closed weekly issue is replaced; its finished items are not carried over.
    const items = [item];
    const issue = await createIssueSafely(ctx, {
      companyId,
      projectId: await projectIdForRow(ctx, companyId, post),
      title: weeklyReviewTitle(weekOf),
      description: weeklyReviewDescription(items),
      priority: "medium",
      originKind: ORIGIN_KIND,
      originId: `${SOCIAL_ORIGINS.weeklyReview}${userId}:${weekOf}`,
      assigneeUserId: userId,
      wake: false,
    });
    state = { issueId: issue.id, userId, weekOf, items };
  }
  await ctx.state.set(weekKey(userId, weekOf), state);
  await ctx.state.set(postKey(post.id), { userId, weekOf });
  return state.issueId;
}

/**
 * The post left review: tick its item, and close the weekly issue when nothing is left. Does nothing for a post that was
 * never on a weekly issue. Never throws.
 */
export async function closeWeeklyReviewItem(ctx: PluginContext, companyId: string, postId: string, note: string): Promise<void> {
  try {
    const ref = (await ctx.state.get(postKey(postId))) as { userId: string; weekOf: string } | null;
    if (!ref) return;
    await ctx.state.delete(postKey(postId));
    const state = (await ctx.state.get(weekKey(ref.userId, ref.weekOf))) as WeeklyState | null;
    if (!state || !(await issueIsOpen(ctx, companyId, state.issueId))) return;
    const item = state.items.find((i) => i.postId === postId);
    if (!item || item.done) return;
    item.done = true;
    await ctx.state.set(weekKey(ref.userId, ref.weekOf), state);
    await ctx.issues.update(state.issueId, { description: weeklyReviewDescription(state.items) }, companyId);
    const allDone = state.items.every((i) => i.done);
    await ctx.issues.createComment(state.issueId, `${item.prefix}${item.snippet}: ${note}${allDone ? "\n\nEvery post on this issue is signed off." : ""}`, companyId);
    if (allDone) await ctx.issues.update(state.issueId, { status: "done" }, companyId);
  } catch (error) {
    ctx.logger.info("Social weekly review item not closed", { postId, error: error instanceof Error ? error.message : String(error) });
  }
}
