/**
 * The review issue of a post: one issue per post (`review:<postId>`), routed by
 * the scope's approval policy.
 *
 * - With a Reviewer in the Cockpit roles and "review outward-facing work" on, a
 *   post sent for review opens an issue for the Reviewer with concrete checks.
 *   The Reviewer records its verdict with `record-review-verdict`; the plugin
 *   hands the issue on (the person who approves, or the Social agent when the
 *   client has to approve).
 * - With no Reviewer nothing opens, as before, except when the scope's policy
 *   needs the client: then the Social agent gets the issue, to send the client
 *   their approval link.
 * - Approval happens when every sign-off the policy needs is in (approval-flow.ts):
 *   a person's click on the Social page, the client's answer on the approval page.
 *   Closing the issue never approves anything.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reviewerAgentId, wakeIssue } from "@partnersinbiz/pib-plugin-kit";
import { defaultPolicy, getPolicy, policySummary, type ApprovalPolicy } from "./approval-policy.js";
import { clientPrefix, scopeOfRow } from "./clients.js";
import { destinationsForPost, getAccountsByIds, postMedia, table, type PostRow } from "./db.js";
import { clip } from "./domain.js";
import { createIssueSafely, ORIGIN_KIND, personAssignee, projectIdForRow, scopeLine, SOCIAL_ORIGINS, socialAssignee } from "./issues.js";
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

export async function reviewIssueOf(ctx: PluginContext, companyId: string, postId: string): Promise<string | null> {
  const rows = await ctx.db.query<{ review_issue_id: string | null }>(
    `SELECT review_issue_id FROM ${table(ctx, "posts")} WHERE id = $1 AND company_id = $2 LIMIT 1`,
    [postId, companyId],
  );
  return rows[0]?.review_issue_id ?? null;
}

export async function issueOpen(ctx: PluginContext, companyId: string, issueId: string): Promise<boolean> {
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    return Boolean(issue && OPEN.has(String(issue.status)));
  } catch {
    return false;
  }
}

/** The Social agent's steps to get the client's approval (the issue text, and the skill's reference). Pure. */
export const CLIENT_APPROVAL_STEPS = [
  "Call `partnersinbiz.social:request-client-approval` with this post's id. It returns the client's approval link, the people at the client, and a ready email text. The link opens a page showing the post exactly as it will appear, with Approve and Request changes buttons.",
  "Email the link with a Mailbox DRAFT. Never send it yourself: a person sends the draft. Normally the plugin has already opened a drafting task for the Account Manager, who holds the mailbox delegation: the call tells you, and then you do nothing more with the email. Only when it tells you to draft it yourself, create it with `partnersinbiz.mailbox:create-draft` (to: one of the people it lists, subject and text as returned).",
  "Then ask the owner once with `partnersinbiz.cockpit:ask-owner` (kind decision, link `/mailbox`): \"Send the approval email to <client>\". End your turn. When the client answers, this issue gets a comment and you are woken; nothing is posted until the client approves.",
];

/** Issue text for the Reviewer: what goes out, where, and the checks. Pure. */
export function postReviewDescription(input: {
  post: Pick<PostRow, "id" | "body" | "first_comment" | "client_kind" | "client_ref" | "client_name" | "media">;
  destinations: string[];
  pagePath: string | null;
  handTo: { userId: string | null; label: string };
  policy?: ApprovalPolicy;
  /** The Reviewer's brief; defaults to `reviewerVerdictBrief`. */
  brief?: string;
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
  );
  if (input.policy) lines.push(`Who approves here: ${policySummary(input.policy)}.`);
  lines.push(
    "Only a person approves: they click **Approve** on the post (or, when the scope's policy says so, the client approves on their link). Closing this issue does not approve it.",
    input.brief ?? reviewerVerdictBrief(input.policy ?? defaultPolicy(null), input.handTo),
  );
  return lines.join("\n");
}

/**
 * What a Reviewer is told to do: check, record a verdict with the tool, and let
 * the plugin hand the issue on (kit `reviewerBrief` says "reassign it yourself",
 * which would undo the hand-off to the Social agent when the client approves). Pure.
 */
export function reviewerVerdictBrief(policy: ApprovalPolicy, handTo: { userId: string | null; label: string }): string {
  const next = policy.requireClient ? "the Social agent, who asks the client to approve" : handTo.label;
  return [
    "",
    "## Reviewer: check before the person approves",
    "You are reviewing: a social post before it is approved and scheduled.",
    "Check:",
    ...POST_REVIEW_CHECKS.map((c) => `- ${c}`),
    "",
    `Then record your verdict with \`partnersinbiz.social:record-review-verdict\` (verdict \`pass\` or \`changes\`, one line per problem in \`notes\`) and comment **PASS** or **CHANGES NEEDED** here. The tool hands this issue on: after a pass to ${next}; after changes back to the Social agent, with the post returned to draft. Do not reassign it yourself, and do not approve, schedule, send or mark it done.`,
  ].join("\n");
}

/** Issue text for the Social agent when the client has to approve and nobody else checks first. Pure. */
export function clientApprovalTaskDescription(input: {
  post: Pick<PostRow, "id" | "body" | "first_comment" | "client_kind" | "client_ref" | "client_name" | "media">;
  destinations: string[];
  pagePath: string | null;
  policy: ApprovalPolicy;
  /** What happened that sends the agent here (a team member's approval, an answer for an older version, an expired link). */
  lead?: string;
}): string {
  return [
    // With a lead (what just happened) the post's own sign-offs are in the lead; without one this is the first ask.
    ...(input.lead
      ? [input.lead, "", "Get the client's approval:"]
      : [`This post needs ${input.policy.requireOwner ? "the client's and a team member's approval" : "the client's approval"} before it can be scheduled. Get the client's approval:`]),
    "",
    ...CLIENT_APPROVAL_STEPS.map((step, i) => `${i + 1}. ${step}`),
    "",
    `**Destinations:** ${input.destinations.length ? input.destinations.join(", ") : "none yet (attach an account first, then send it for review again)"}`,
    scopeLine(input.post),
    `Post id: \`${input.post.id}\``,
    "",
    "> " + clip(input.post.body, 2000).replace(/\n/g, "\n> "),
    "",
    input.pagePath ? `Open it: [Social → Posts](${input.pagePath})` : "Open it on the Social page → Posts.",
    `Who approves here: ${policySummary(input.policy)}.`,
    "If you change the post after the link was made, the link no longer counts: make a new one. Closing this issue does not approve the post.",
  ].join("\n");
}

async function destinationNames(ctx: PluginContext, companyId: string, post: PostRow): Promise<string[]> {
  const destinations = await destinationsForPost(ctx, post.id);
  const accounts = await getAccountsByIds(ctx, companyId, destinations.map((d) => d.account_id));
  return accounts.map((a) => `${platformName(a.platform)} · ${a.display_name}`);
}

/**
 * Hands the post's open review issue to someone, with a comment and (for an
 * agent) a wake-up. Returns false when there is no open review issue.
 */
export async function handReviewIssue(
  ctx: PluginContext,
  companyId: string,
  post: Pick<PostRow, "id" | "owner_user_id">,
  to: { agentId: string } | { userId: string },
  comment: string,
  wakeReason: string,
): Promise<boolean> {
  try {
    const issueId = await reviewIssueOf(ctx, companyId, post.id);
    if (!issueId || !(await issueOpen(ctx, companyId, issueId))) return false;
    const patch = "agentId" in to ? { status: "todo" as const, assigneeAgentId: to.agentId, assigneeUserId: null } : { status: "todo" as const, assigneeAgentId: null, assigneeUserId: to.userId };
    await ctx.issues.update(issueId, patch, companyId);
    await ctx.issues.createComment(issueId, comment, companyId);
    if ("agentId" in to) await wakeIssue(ctx, issueId, companyId, wakeReason);
    return true;
  } catch (error) {
    ctx.logger.info("Social review hand-off skipped", { postId: post.id, error: errorMessage(error) });
    return false;
  }
}

/** Issue text for the Social agent when someone asked for changes and no open review issue is there to carry the note. Pure. */
export function changesTaskDescription(input: {
  post: Pick<PostRow, "id" | "body" | "first_comment" | "client_kind" | "client_ref" | "client_name" | "media">;
  destinations: string[];
  pagePath: string | null;
  note: string;
}): string {
  return [
    input.note,
    "",
    `**Destinations:** ${input.destinations.length ? input.destinations.join(", ") : "none yet (attach an account before sending it for review again)"}`,
    scopeLine(input.post),
    `Post id: \`${input.post.id}\``,
    "",
    "> " + clip(input.post.body, 2000).replace(/\n/g, "\n> "),
    "",
    input.pagePath ? `Open it: [Social → Posts](${input.pagePath})` : "Open it on the Social page → Posts.",
    "Closing this issue does not approve the post: only the people the scope's approval policy names do.",
  ].join("\n");
}

export type SocialTask = "client-approval" | "changes";

/**
 * Gives the Social agent the post's review issue with a note, and wakes it. This issue is the only way the agent hears about a
 * post, so it is never lost: an open one is reassigned to the agent (back to todo, even when an ask left it with the owner); a
 * closed one (agents close issues after drafting the email) or none at all (the policy changed after the post went to review)
 * is replaced by a fresh issue for the same post (`review:<postId>`), which carries the note itself. Returns the issue id, or
 * null when nobody can take it or the host refused. Never throws.
 */
export async function handToSocialAgent(
  ctx: PluginContext,
  companyId: string,
  post: PostRow,
  input: { task: SocialTask; note: string; wakeReason: string },
): Promise<string | null> {
  try {
    const targets = await handoffTargets(ctx, companyId, post);
    if (!targets.social) return null;
    const existing = await reviewIssueOf(ctx, companyId, post.id);
    if (existing && (await issueOpen(ctx, companyId, existing))) {
      return (await handReviewIssue(ctx, companyId, post, targets.social, input.note, input.wakeReason)) ? existing : null;
    }
    const social = targets.social;
    const names = await destinationNames(ctx, companyId, post);
    const pagePath = await socialPath(ctx, companyId, { tab: "posts" }, scopeOfRow(post));
    const snippet = clip(post.body.replace(/\s+/g, " ").trim(), 60);
    const client = input.task === "client-approval";
    const issue = await createIssueSafely(ctx, {
      companyId,
      projectId: await projectIdForRow(ctx, companyId, post),
      title: `${clientPrefix(post)}${client ? "Get client approval for" : "Fix after requested changes:"} social post: ${snippet}`,
      description: client
        ? clientApprovalTaskDescription({ post, destinations: names, pagePath, policy: await getPolicy(ctx, companyId, scopeOfRow(post)), lead: input.note })
        : changesTaskDescription({ post, destinations: names, pagePath, note: input.note }),
      priority: "medium",
      originKind: ORIGIN_KIND,
      originId: `${SOCIAL_ORIGINS.review}${post.id}`,
      ...("agentId" in social ? { assigneeAgentId: social.agentId } : { assigneeUserId: social.userId }),
      wakeReason: input.wakeReason,
    });
    await ctx.db.execute(`UPDATE ${table(ctx, "posts")} SET review_issue_id = $3 WHERE id = $1 AND company_id = $2`, [post.id, companyId, issue.id]);
    return issue.id;
  } catch (error) {
    ctx.logger.info("Social agent hand-off skipped", { postId: post.id, task: input.task, error: errorMessage(error) });
    return null;
  }
}

/** Who a hand-off to "the Social agent" or "the approving person" goes to. */
export async function handoffTargets(ctx: PluginContext, companyId: string, post: Pick<PostRow, "owner_user_id">): Promise<{ social: { agentId: string } | { userId: string } | null; person: { userId: string } | null }> {
  const assignee = await socialAssignee(ctx, companyId, post.owner_user_id);
  const social = assignee.assigneeAgentId ? { agentId: assignee.assigneeAgentId } : assignee.assigneeUserId ? { userId: assignee.assigneeUserId } : null;
  const userId = await personAssignee(ctx, companyId, post.owner_user_id);
  return { social, person: userId ? { userId } : null };
}

/** A post moved to review: route it by the scope's policy. Never throws. */
export async function routePostReview(ctx: PluginContext, actor: ReviewActor, post: PostRow): Promise<string | null> {
  const companyId = actor.companyId;
  try {
    const policy = await getPolicy(ctx, companyId, scopeOfRow(post));
    const reviewer = await reviewerAgentId(ctx, companyId);
    // No Reviewer: nothing opens (a person approves from the Social page and the Cockpit lists the post), unless the client
    // has to approve: then the Social agent gets the issue, to send the client their link.
    if (!reviewer && !policy.requireClient) return null;
    const social = reviewer ? null : (await handoffTargets(ctx, companyId, post)).social;
    const person = (await personAssignee(ctx, companyId, post.owner_user_id)) ?? null;
    const handTo = { userId: person, label: person ? `user \`${person}\` (who approves this post)` : "a board user who approves posts" };
    const existing = await reviewIssueOf(ctx, companyId, post.id);
    if (existing && (await issueOpen(ctx, companyId, existing))) {
      if (reviewer) {
        await ctx.issues.update(existing, { status: "todo", assigneeAgentId: reviewer, assigneeUserId: null }, companyId);
        await ctx.issues.createComment(existing, "The post was sent for review again. Check the latest version.", companyId);
        await wakeIssue(ctx, existing, companyId, "Social post sent for review again");
      } else if (social) {
        const patch = "agentId" in social ? { status: "todo" as const, assigneeAgentId: social.agentId, assigneeUserId: null } : { status: "todo" as const, assigneeAgentId: null, assigneeUserId: social.userId };
        await ctx.issues.update(existing, patch, companyId);
        await ctx.issues.createComment(existing, "The post was sent for review again. Earlier client links no longer match it: make a new one with `request-client-approval`.", companyId);
        if ("agentId" in social) await wakeIssue(ctx, existing, companyId, "Social post sent for review again");
      }
      return existing;
    }
    const names = await destinationNames(ctx, companyId, post);
    const pagePath = await socialPath(ctx, companyId, { tab: "posts" }, scopeOfRow(post));
    const issue = await createIssueSafely(ctx, {
      companyId,
      projectId: await projectIdForRow(ctx, companyId, post),
      title: `${clientPrefix(post)}${reviewer ? "Review" : "Get client approval for"} social post: ${clip(post.body.replace(/\s+/g, " ").trim(), 60)}`,
      description: reviewer
        ? postReviewDescription({ post, destinations: names, pagePath, handTo, policy, brief: reviewerVerdictBrief(policy, handTo) })
        : clientApprovalTaskDescription({ post, destinations: names, pagePath, policy }),
      priority: "medium",
      originKind: ORIGIN_KIND,
      originId: `${SOCIAL_ORIGINS.review}${post.id}`,
      ...(reviewer
        ? { assigneeAgentId: reviewer }
        : social
          ? "agentId" in social ? { assigneeAgentId: social.agentId } : { assigneeUserId: social.userId }
          : {}),
      wakeReason: reviewer ? "Social post needs a review" : "Social post needs the client's approval",
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
 * a note (`approvedNote` says what happened to the schedule on approval).
 * Never throws.
 */
export async function closePostReview(ctx: PluginContext, actor: ReviewActor, post: PostRow, to: PostStatus, approvedNote?: string): Promise<void> {
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
      ? approvedNote ?? "A person approved the post."
      : `${byPerson ? "A person" : "The agent"} moved the post back to draft for changes. A new review opens when it is sent for review again.`;
    await ctx.issues.createComment(issueId, note, companyId);
    await ctx.issues.update(issueId, { status: "done" }, companyId);
  } catch (error) {
    ctx.logger.info("Social review close skipped", { postId: post.id, error: errorMessage(error) });
  }
}
