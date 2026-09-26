/**
 * Reviewer routing for posts (Company Cockpit roles).
 *
 * When the Cockpit has a Reviewer and "review outward-facing work" is on, a
 * post sent for review opens an issue for the Reviewer agent with concrete
 * checks. The Reviewer comments PASS / CHANGES NEEDED and hands the issue to
 * the person who approves posts. Approval still happens only when a person
 * clicks Approve on the Social page. With no Reviewer nothing opens, as before.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reviewerAgentId, reviewerBrief, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { clientPrefix, scopeOfRow } from "./clients.js";
import { destinationsForPost, getAccountsByIds, postMedia, table, type PostRow } from "./db.js";
import { clip } from "./domain.js";
import { createIssueSafely, ORIGIN_KIND, scopeLine, socialProjectId } from "./issues.js";
import { socialPath } from "./oauth/flow.js";
import { isSocialPlatform, PLATFORM_LABELS, type PostStatus } from "./platforms.js";

export const POST_REVIEW_CHECKS = [
  "Platform limits: length, hashtags, media format and count fit every destination (run `validate-post`).",
  "Brand voice and the rules in this scope's Growth Lab playbook (`get-playbook`).",
  "Claims and numbers are true and backed by a source; no promises the business cannot keep.",
  "Links open the right page and carry UTM tags.",
  "Media is attached where the platform needs it (Instagram, TikTok, YouTube, Pinterest) and has alt text.",
  "Client scope is right: only this scope's accounts and media, and no other client's name or data.",
  "No personal data (private people's names, phone numbers, emails or addresses) unless they agreed.",
];

const OPEN = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export interface ReviewActor {
  companyId: string;
  userId: string | null;
  isAgent: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function platformName(platform: string): string {
  return isSocialPlatform(platform) ? PLATFORM_LABELS[platform] : platform;
}

async function defaultPerson(ctx: PluginContext, companyId: string): Promise<string | null> {
  try {
    return (await ctx.companies.get(companyId))?.defaultResponsibleUserId ?? null;
  } catch {
    return null;
  }
}

async function reviewIssueOf(ctx: PluginContext, companyId: string, postId: string): Promise<string | null> {
  const rows = await ctx.db.query<{ review_issue_id: string | null }>(
    `SELECT review_issue_id FROM ${table(ctx, "posts")} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [postId, companyId],
  );
  return rows[0]?.review_issue_id ?? null;
}

async function issueOpen(ctx: PluginContext, companyId: string, issueId: string): Promise<boolean> {
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    return Boolean(issue && OPEN.has(String(issue.status)));
  } catch {
    return false;
  }
}

/** Issue text for the Reviewer: what goes out, where, and the checks. Pure. */
export function postReviewDescription(input: {
  post: Pick<PostRow, "id" | "body" | "first_comment" | "client_kind" | "client_ref" | "client_name" | "media">;
  destinations: string[];
  pagePath: string | null;
  handTo: { userId: string | null; label: string };
}): string {
  const media = postMedia(input.post);
  const lines = [
    "A social post was sent for review. Check it before the person approves it.",
    "",
    `**Destinations:** ${input.destinations.length ? input.destinations.join(", ") : "none yet (the post needs at least one account before it can be scheduled)"}`,
    `**Media:** ${media.length ? media.map((m) => `${m.kind}${m.altText ? "" : " (no alt text)"}`).join(", ") : "none"}`,
    scopeLine(input.post),
    `Post id: \`${input.post.id}\``,
    "",
    "> " + clip(input.post.body, 2000).replace(/\n/g, "\n> "),
  ];
  if (input.post.first_comment) lines.push("", `First comment: ${clip(input.post.first_comment, 500)}`);
  lines.push(
    "",
    input.pagePath ? `Open it: [Social → Posts](${input.pagePath})` : "Open it on the Social page → Posts.",
    "Only a person approves: they click **Approve** on the post. Closing this issue does not approve it.",
    reviewerBrief({ what: "a social post before it is approved and scheduled", checks: POST_REVIEW_CHECKS, handTo: input.handTo }),
  );
  return lines.join("\n");
}

/** A post moved to review: route it to the Reviewer first when one is set. Never throws. */
export async function routePostReview(ctx: PluginContext, actor: ReviewActor, post: PostRow): Promise<string | null> {
  const companyId = actor.companyId;
  try {
    const reviewer = await reviewerAgentId(ctx, companyId);
    if (!reviewer) return null;
    const person = post.owner_user_id ?? (await defaultPerson(ctx, companyId));
    const handTo = { userId: person, label: person ? `user \`${person}\` (who approves this post)` : "a board user who approves posts" };
    const existing = await reviewIssueOf(ctx, companyId, post.id);
    if (existing && (await issueOpen(ctx, companyId, existing))) {
      await ctx.issues.update(existing, { status: "todo", assigneeAgentId: reviewer, assigneeUserId: null }, companyId);
      await ctx.issues.createComment(existing, "The post was sent for review again. Check the latest version.", companyId);
      await wakeIssue(ctx, existing, companyId, "Social post sent for review again");
      return existing;
    }
    const destinations = await destinationsForPost(ctx, post.id);
    const accounts = await getAccountsByIds(ctx, companyId, destinations.map((d) => d.account_id));
    const names = accounts.map((a) => `${platformName(a.platform)} · ${a.display_name}`);
    const issue = await createIssueSafely(ctx, {
      companyId,
      projectId: await socialProjectId(ctx, companyId),
      title: `${clientPrefix(post)}Review social post: ${clip(post.body.replace(/\s+/g, " ").trim(), 60)}`,
      description: postReviewDescription({
        post,
        destinations: names,
        pagePath: await socialPath(ctx, companyId, { tab: "posts" }, scopeOfRow(post)),
        handTo,
      }),
      priority: "medium",
      originKind: ORIGIN_KIND,
      originId: `review:${post.id}`,
      assigneeAgentId: reviewer,
      wakeReason: "Social post needs a review",
    });
    await ctx.db.execute(`UPDATE ${table(ctx, "posts")} SET review_issue_id = $3 WHERE id = $1 AND company_id = $2`, [post.id, companyId, issue.id]);
    return issue.id;
  } catch (error) {
    ctx.logger.info("Social review routing skipped", { postId: post.id, error: errorMessage(error) });
    return null;
  }
}

/**
 * A post left review. A person sending it back to draft counts as "changes
 * requested" (Cockpit quality). The Reviewer's issue, if any, is closed with
 * a note. Never throws.
 */
export async function closePostReview(ctx: PluginContext, actor: ReviewActor, post: PostRow, to: PostStatus): Promise<void> {
  if (post.status !== "review" || (to !== "approved" && to !== "draft")) return;
  const companyId = actor.companyId;
  const byPerson = !actor.isAgent && Boolean(actor.userId);
  try {
    const issueId = await reviewIssueOf(ctx, companyId, post.id);
    const returned = to === "draft" && byPerson ? 1 : 0;
    if (!issueId && !returned) return;
    await ctx.db.execute(
      `UPDATE ${table(ctx, "posts")} SET review_issue_id = NULL, review_returns = review_returns + $3 WHERE id = $1 AND company_id = $2`,
      [post.id, companyId, returned],
    );
    if (!issueId || !(await issueOpen(ctx, companyId, issueId))) return;
    const note = to === "approved"
      ? "A person approved the post. It can be scheduled now."
      : `${byPerson ? "A person" : "The agent"} moved the post back to draft for changes. A new review opens when it is sent for review again.`;
    await ctx.issues.createComment(issueId, note, companyId);
    await ctx.issues.update(issueId, { status: "done" }, companyId);
  } catch (error) {
    ctx.logger.info("Social review close skipped", { postId: post.id, error: errorMessage(error) });
  }
}
