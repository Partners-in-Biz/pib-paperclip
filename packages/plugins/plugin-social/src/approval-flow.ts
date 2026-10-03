/**
 * Sign-offs and approval (Q1a-2). A post in review becomes approved when every
 * sign-off its scope's policy needs is in for the CURRENT version of the post:
 *
 * - the owner: a person clicks Approve on the Social page (`approvePostByPerson`);
 * - the Reviewer: it passed the post (`recordReviewerVerdict`), a check, never an approval;
 * - the client: they approved on the approval page (the answer job applies it,
 *   `applyClientAnswer` in client-approval.ts), or a person recorded that the
 *   client approved elsewhere, with a note (`recordClientApprovalByPerson`).
 *
 * No agent approves: the only agent verdict is the Reviewer's pass/changes, and an
 * approval needs a person or the client behind it. Nothing here is new authority
 * for the default policy (the owner approves): that path behaves as before.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reviewerAgentId } from "@partnersinbiz/pib-plugin-kit";
import { getPolicy, missingStages, policyOut, policySummary, stageList, type ApprovalPolicy } from "./approval-policy.js";
import { scopeOfRow } from "./clients.js";
import { postFingerprint } from "./content-hash.js";
import { destinationsForPost, getAccountsByIds, getPost, setPostStatus, table, type PostRow } from "./db.js";
import { SocialError } from "./domain.js";
import { closePostReview, handReviewIssue, handToSocialAgent, handoffTargets, issueOpen, reviewIssueOf, routePostReview, type ReviewActor } from "./review.js";
import { currentSignoffs, outcomesForPost, recordOutcome, type OutcomeActor, type Stage, type StageState } from "./review-outcomes.js";
import { scheduleApproved, type ApprovalOutcome } from "./schedule.js";
import { validatePostRow } from "./validate.js";

export interface SignoffState {
  policy: ApprovalPolicy;
  hash: string;
  accountIds: string[];
  signoffs: Record<Stage, StageState>;
  missing: Stage[];
}

/** Where every sign-off stands for the post's current version. */
export async function signoffState(ctx: PluginContext, companyId: string, post: PostRow): Promise<SignoffState> {
  const policy = await getPolicy(ctx, companyId, scopeOfRow(post));
  const { hash, accountIds } = await postFingerprint(ctx, post);
  const rows = await outcomesForPost(ctx, companyId, post.id).catch(() => []);
  const signoffs = currentSignoffs(rows, hash);
  return { policy, hash, accountIds, signoffs, missing: missingStages(policy, signoffs) };
}

/** The state with one sign-off counted as given right now (before the ledger write is read back). Pure. */
export function withSignoff(state: SignoffState, stage: Stage): SignoffState {
  const signoffs = { ...state.signoffs, [stage]: "approved" as const };
  return { ...state, signoffs, missing: missingStages(state.policy, signoffs) };
}

/** What the page and tools show about a post's approval. */
export async function approvalView(ctx: PluginContext, companyId: string, post: PostRow) {
  const state = await signoffState(ctx, companyId, post);
  return { policy: policyOut(state.policy), signoffs: state.signoffs, missing: state.missing };
}

export interface ApprovalProgress {
  completed: boolean;
  /** Sign-offs still missing after this one. */
  pending: Stage[];
  message: string;
  approval?: ApprovalOutcome;
}

/** The platforms a post's destinations are on (the outcome keeps them for the per-type stats). */
async function platformsOf(ctx: PluginContext, companyId: string, post: PostRow): Promise<string[]> {
  const destinations = await destinationsForPost(ctx, post.id);
  return (await getAccountsByIds(ctx, companyId, destinations.map((d) => d.account_id))).map((a) => a.platform);
}

/** Records a verdict without ever failing the caller: the ledger is evidence, the post's state is the truth. */
export async function recordSignoff(
  ctx: PluginContext,
  companyId: string,
  post: PostRow,
  hash: string,
  stage: Stage,
  outcome: "approved" | "changes",
  via: "tool" | "ui" | "link" | "recorded",
  actor: OutcomeActor,
  note?: string | null,
): Promise<void> {
  try {
    await recordOutcome(ctx, { companyId, post, platforms: await platformsOf(ctx, companyId, post), stage, outcome, contentHash: hash, via, actor, note });
  } catch (error) {
    ctx.logger.info("Social review outcome not recorded", { postId: post.id, stage, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Closes the client's open links for a post: it was edited, approved or sent back, so a link made earlier would only let the client
 * answer for something that no longer counts. The page then says the link is no longer current. Never throws.
 */
export async function supersedePendingLinks(ctx: PluginContext, companyId: string, postId: string): Promise<number> {
  try {
    const result = await ctx.db.execute(`UPDATE ${table(ctx, "client_approvals")} SET status = 'superseded' WHERE post_id = $1 AND company_id = $2 AND status = 'pending'`, [postId, companyId]);
    return result.rowCount ?? 0;
  } catch (error) {
    ctx.logger.info("Social client links not superseded", { postId, error: error instanceof Error ? error.message : String(error) });
    return 0;
  }
}

/** True when the client already holds an open link for this exact version of the post (a second email would only confuse them). */
export async function openLinkFor(ctx: PluginContext, companyId: string, postId: string, hash: string): Promise<boolean> {
  try {
    const rows = await ctx.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table(ctx, "client_approvals")}
        WHERE post_id = $1 AND company_id = $2 AND status = 'pending' AND content_hash = $3 AND expires_at > now()`,
      [postId, companyId, hash],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/** The post moves to approved, is scheduled (or handed to the Social agent for a time), and its review issue closes. */
export async function completeApproval(ctx: PluginContext, actor: ReviewActor, post: PostRow, who: string, extraNote?: string): Promise<ApprovalProgress> {
  const companyId = actor.companyId;
  const fresh = await getPost(ctx, companyId, post.id);
  if (!fresh || fresh.status !== "review") throw new SocialError("The post is no longer in review. Reload and try again.");
  if (!(await setPostStatus(ctx, companyId, post.id, ["review"], "approved"))) throw new SocialError("The post changed while you were editing it. Reload and try again.");
  const approval = await scheduleApproved(ctx, companyId, post.id, async (id) => {
    const row = await getPost(ctx, companyId, id);
    return row ? validatePostRow(ctx, companyId, row) : { ok: false, problems: ["The post was removed"] };
  }, new Date(), who);
  await closePostReview(ctx, actor, fresh, "approved", extraNote ? `${approval.note} ${extraNote}` : approval.note);
  await supersedePendingLinks(ctx, companyId, post.id);
  return { completed: true, pending: [], message: approval.message, approval };
}

/** What is left to do after a sign-off: complete the approval, or hand the issue to whoever has to act next. */
export async function afterSignoff(ctx: PluginContext, actor: ReviewActor, post: PostRow, state: SignoffState, who: string, note?: string, lead?: string): Promise<ApprovalProgress> {
  if (state.missing.length === 0) return completeApproval(ctx, actor, post, who, note);
  const companyId = actor.companyId;
  const waiting = stageList(state.missing);
  const targets = await handoffTargets(ctx, companyId, post);
  const intro = lead ? `${lead}\n\n` : "";
  let handed = false;
  if (state.missing.includes("client")) {
    // The client's link needs an agent to make it and a Mailbox draft; a team member's click (if also needed) shows in the Cockpit's waiting list.
    // A link for this exact version is already out: the agent is not sent to make (and email) a second one. With no open review issue
    // (an agent closed it, or the post was already in review when the policy began to ask for the client) a fresh one is opened for it.
    if (!(await openLinkFor(ctx, companyId, post.id, state.hash))) {
      handed = Boolean(await handToSocialAgent(ctx, companyId, post, { task: "client-approval", note: `${intro}Next: ${waiting}. Get the client's approval with \`request-client-approval\` and a Mailbox draft (never send it yourself). Nothing is posted until then.`, wakeReason: "Social post needs the client's approval" }));
    }
  } else if (state.missing.includes("owner") && targets.person) {
    handed = await handReviewIssue(ctx, companyId, post, targets.person, `${intro}Next: ${waiting}. Open the post on the Social page → Posts and click Approve.`, "Social post needs a team member's approval");
  }
  // Nobody to hand to (or no open issue): the sign-off still goes on the issue, when there is one.
  if (!handed && lead) {
    const issueId = await reviewIssueOf(ctx, companyId, post.id);
    if (issueId && (await issueOpen(ctx, companyId, issueId))) await ctx.issues.createComment(issueId, `${lead}\n\nStill needed: ${waiting}.`, companyId).catch(() => undefined);
  }
  return { completed: false, pending: state.missing, message: `Recorded. Waiting for ${waiting}.` };
}

/** A person clicks Approve. Needs the policy to ask for a team member, and the Reviewer's pass first when it asks for that. */
export async function approvePostByPerson(ctx: PluginContext, actor: ReviewActor, post: PostRow): Promise<ApprovalProgress> {
  const companyId = actor.companyId;
  const before = await signoffState(ctx, companyId, post);
  if (!before.policy.requireOwner) {
    throw new SocialError("In this scope the client approves, not a team member. Send the client their approval link, or record that the client approved (with a note).");
  }
  if (before.policy.requireReviewer && before.signoffs.reviewer !== "approved") {
    throw new SocialError(before.signoffs.reviewer === "changes" ? "The Reviewer asked for changes to this post. Send it back to draft, fix it and send it for review again." : "The Reviewer has not passed this version yet. Its pass comes first in this scope.");
  }
  await recordSignoff(ctx, companyId, post, before.hash, "owner", "approved", "ui", { userId: actor.userId });
  return afterSignoff(ctx, actor, post, withSignoff(before, "owner"), "A person");
}

/** A person records that the client approved outside the approval page (an email, a call). A note saying how is required. */
export async function recordClientApprovalByPerson(ctx: PluginContext, actor: ReviewActor, post: PostRow, note: string, by?: string | null): Promise<ApprovalProgress> {
  const companyId = actor.companyId;
  const text = note.trim();
  if (text.length < 10) throw new SocialError("Say how the client approved (who, when and how), at least a few words: it is kept as the approval record.");
  const before = await signoffState(ctx, companyId, post);
  if (!before.policy.requireClient) throw new SocialError("This scope's policy does not ask for the client's approval.");
  if (before.policy.requireReviewer && before.signoffs.reviewer !== "approved") throw new SocialError("The Reviewer has not passed this version yet. Its pass comes first in this scope.");
  await recordSignoff(ctx, companyId, post, before.hash, "client", "approved", "recorded", { userId: actor.userId, name: by ?? null }, text);
  return afterSignoff(ctx, actor, post, withSignoff(before, "client"), "A person, recording the client's approval,", `Record: ${text.slice(0, 300)}`);
}

export interface VerdictInput {
  agentId: string;
  verdict: "pass" | "changes";
  notes: string | null;
}

/** The Reviewer's verdict on a post in review. Only the company's Reviewer may record it. */
export async function recordReviewerVerdict(ctx: PluginContext, companyId: string, post: PostRow, input: VerdictInput): Promise<{ recorded: boolean; verdict: string; next: string }> {
  const reviewer = await reviewerAgentId(ctx, companyId);
  if (!reviewer) throw new SocialError("This company has no Reviewer set (Setup → Team), so there is nobody to record a review verdict.");
  if (reviewer !== input.agentId) throw new SocialError("Only the Reviewer records a review verdict. You draft and send posts for review.");
  if (post.status !== "review") throw new SocialError(`The post is ${post.status.replace("_", " ")}, not in review: there is nothing to check.`);
  const notes = input.notes?.trim() || null;
  if (input.verdict === "changes" && !notes) throw new SocialError("Say what has to change (notes): the Social agent works from your list.");
  const before = await signoffState(ctx, companyId, post);
  await recordSignoff(ctx, companyId, post, before.hash, "reviewer", input.verdict === "pass" ? "approved" : "changes", "tool", { agentId: input.agentId }, notes);
  const actor: ReviewActor = { companyId, userId: null, isAgent: true };
  if (input.verdict === "changes") {
    await sendBackForChanges(ctx, companyId, post, "The Reviewer", notes ?? "", false);
    return { recorded: true, verdict: "changes", next: "The post is back in draft and the Social agent has your notes." };
  }
  const progress = await afterSignoff(ctx, actor, post, withSignoff(before, "reviewer"), "A person");
  return { recorded: true, verdict: "pass", next: progress.completed ? "Nothing else was needed: the post is approved." : `Handed on: ${stageList(progress.pending)} still has to approve. Nothing is posted until then.` };
}

/**
 * The post goes back to draft with someone's list of changes, and the Social agent
 * gets the review issue (kept open: sending the post for review again reuses it).
 * `person` counts it as a return for the Cockpit's quality metric.
 */
export async function sendBackForChanges(ctx: PluginContext, companyId: string, post: PostRow, who: string, notes: string, person: boolean): Promise<void> {
  if (!(await setPostStatus(ctx, companyId, post.id, ["review"], "draft"))) return;
  await supersedePendingLinks(ctx, companyId, post.id);
  if (person) {
    await ctx.db.execute(`UPDATE ${table(ctx, "posts")} SET review_returns = review_returns + 1 WHERE id = $1 AND company_id = $2`, [post.id, companyId]).catch(() => undefined);
  }
  const text = `${who} asked for changes:\n\n> ${notes.replace(/\n/g, "\n> ")}\n\nThe post is back in draft. Fix every point, then send it for review again (\`request-review\`).`;
  // The note has to reach the Social agent even when its review issue was closed or never opened: handToSocialAgent opens a fresh one then.
  await handToSocialAgent(ctx, companyId, post, { task: "changes", note: text, wakeReason: "Changes requested on a social post" });
}

/**
 * A post in review that is waiting on an agent's step but has no open review issue to say so: the policy began to ask for the
 * client after the post went to review, or an agent closed the issue. Opens the issue the next step needs (the Reviewer's check,
 * or the Social agent's client link). Returns true when it did. A post that waits only for a person is left to the Cockpit's list.
 */
export async function routeWaitingPost(ctx: PluginContext, actor: ReviewActor, post: PostRow): Promise<boolean> {
  const companyId = actor.companyId;
  const issueId = await reviewIssueOf(ctx, companyId, post.id);
  if (issueId && (await issueOpen(ctx, companyId, issueId))) return false;
  const state = await signoffState(ctx, companyId, post);
  if (state.missing.includes("reviewer")) return Boolean(await routePostReview(ctx, actor, post));
  if (state.missing.includes("client") && !(await openLinkFor(ctx, companyId, post.id, state.hash))) {
    return Boolean(await handToSocialAgent(ctx, companyId, post, { task: "client-approval", note: `The approval policy for this post now asks for the client's approval (Who approves: ${policySummary(state.policy)}). Get it with \`request-client-approval\` and a Mailbox draft (never send it yourself). Nothing is posted until then.`, wakeReason: "Social post needs the client's approval" }));
  }
  return false;
}
