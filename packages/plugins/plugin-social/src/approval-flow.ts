/**
 * Sign-offs and approval (Q1a-2). A post in review becomes approved when every
 * sign-off its scope's policy needs is in for the CURRENT version of the post:
 *
 * - the owner: a person clicks Approve on the Social page (`approvePostByPerson`), or the scope's
 *   delegated approver approves (`approvePostByDelegate`, below);
 * - the Reviewer: it passed the post (`recordReviewerVerdict`), a check, never an approval;
 * - the client: they approved on the approval page (the answer job applies it,
 *   `applyClientAnswer` in client-approval.ts), or a person recorded that the
 *   client approved elsewhere, with a note (`recordClientApprovalByPerson`).
 *
 * - the owner's delegate: the agent a person named for the scope approves with
 *   `approve-post-as-delegate` (`approvePostByDelegate`), after a scored Reviewer pass.
 *
 * No other agent approves, and never the Social agent: the Reviewer's verdict is a check, never an
 * approval. An approval comes from a person, the client, or the agent a person named for that scope. Nothing here is
 * new authority for the default policy (the owner approves): that path behaves as before.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { reviewerAgentId } from "@partnersinbiz/pib-plugin-kit";
import { delegateBlockers, delegateFacts, delegateView, getDelegate, ladderDelegation } from "./approval-delegate.js";
import { getPolicy, getPolicyStrict, missingStages, policyOut, policySummary, stageList, type ApprovalPolicy } from "./approval-policy.js";
import { scopeOfRow } from "./clients.js";
import { postFingerprint } from "./content-hash.js";
import { destinationsForPost, getAccountsByIds, getPost, postMedia, setPostStatus, table, type PostRow } from "./db.js";
import { SocialError } from "./domain.js";
import { requireCanActOnPost } from "./ownership.js";
import { closePostReview, delegateForPost, handReviewIssue, handToDelegate, handToSocialAgent, handoffTargets, issueOpen, reviewIssueOf, routePostReview, type ReviewActor } from "./review.js";
import { AUTO_APPROVE_STREAK, autoApprovalDecision, ownerStreak } from "./autonomy.js";
import { currentSignoffs, ladderRows, outcomesForPost, postTypeOf, recordOutcome, statRows, summariseOutcomes, type OutcomeActor, type OutcomeRow, type Stage, type StageState } from "./review-outcomes.js";
import { scheduleApproved, type ApprovalOutcome } from "./schedule.js";
import { closeWeeklyReviewItem } from "./weekly-review.js";
import { validatePostRow } from "./validate.js";
import { growthEnv, type GrowthEnv } from "./growth/host.js";
import { effectiveMediaRule } from "./growth/service.js";
import type { Experiment } from "./growth/store.js";
import type { MediaExperiment } from "@partnersinbiz/pib-plugin-kit";

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
  const [state, delegate] = await Promise.all([signoffState(ctx, companyId, post), delegateView(ctx, companyId, post.scope === "personal" ? "personal" : scopeOfRow(post))]);
  return { policy: policyOut(state.policy, delegate), signoffs: state.signoffs, missing: state.missing };
}

export interface ApprovalProgress {
  completed: boolean;
  /** Sign-offs still missing after this one. */
  pending: Stage[];
  message: string;
  /** The scope's delegated approver the post was handed to (only the owner's sign-off was missing). */
  delegateAgentId?: string;
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
  via: "tool" | "ui" | "link" | "recorded" | "auto" | "delegate" | "unscored",
  actor: OutcomeActor,
  note?: string | null,
): Promise<boolean> {
  try {
    await recordOutcome(ctx, { companyId, post, platforms: await platformsOf(ctx, companyId, post), stage, outcome, contentHash: hash, via, actor, note });
    return true;
  } catch (error) {
    ctx.logger.info("Social review outcome not recorded", { postId: post.id, stage, error: error instanceof Error ? error.message : String(error) });
    return false;
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

/**
 * The autonomy ladder: a low-risk post whose only missing sign-off is the team member's click, and whose owner streak for its
 * type in this scope is at least AUTO_APPROVE_STREAK, is approved here (rule in autonomy.ts). Returns null when the post is not
 * eligible or anything fails: a person approves it as before. A Reviewer's pass the policy asks for must already be in.
 * Off in a scope with a stored delegate (Q8), and when the delegate store cannot be read: the delegate decides there.
 */
export async function tryAutoApprove(ctx: PluginContext, actor: ReviewActor, post: PostRow, known?: SignoffState): Promise<ApprovalProgress | null> {
  try {
    if (post.status !== "review" || post.scope === "personal") return null;
    const companyId = actor.companyId;
    const state = known ?? (await signoffState(ctx, companyId, post));
    if (!state.policy.requireOwner || !state.missing.includes("owner")) return null;
    if ((await ladderDelegation(ctx, companyId, scopeOfRow(post))) !== null) return null;
    const type = postTypeOf(post);
    // Cheap checks first: the validation and the stats are only read for a post that could qualify.
    const quick = autoApprovalDecision({ kind: type.kind, format: type.format, requireClient: state.policy.requireClient, missing: state.missing, validateOk: true, streak: AUTO_APPROVE_STREAK });
    if (!quick.eligible) return null;
    const check = await validatePostRow(ctx, companyId, post);
    const streak = ownerStreak(summariseOutcomes(ladderRows(await statRows(ctx, companyId, scopeOfRow(post), 90))), type.type);
    const decision = autoApprovalDecision({ kind: type.kind, format: type.format, requireClient: state.policy.requireClient, missing: state.missing, validateOk: check.ok, streak });
    if (!decision.eligible) return null;
    const note = `Auto-approved: low-risk ${type.type} post, ${streak} team approvals in a row for this type in this scope.`;
    // Complete first: if it throws, no "auto" sign-off row is left behind for a post that stays in review.
    const done = await completeApproval(ctx, actor, post, "The autonomy ladder", note);
    await recordSignoff(ctx, companyId, post, state.hash, "owner", "approved", "auto", { name: "Autonomy ladder" }, note);
    return done;
  } catch (error) {
    ctx.logger.info("Social auto-approval skipped", { postId: post.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** What is left to do after a sign-off: complete the approval, or hand the issue to whoever has to act next. */
export async function afterSignoff(ctx: PluginContext, actor: ReviewActor, post: PostRow, state: SignoffState, who: string, note?: string, lead?: string): Promise<ApprovalProgress> {
  if (state.missing.length === 0) return completeApproval(ctx, actor, post, who, note);
  const auto = await tryAutoApprove(ctx, actor, post, state);
  if (auto) return auto;
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
  } else if (state.missing.includes("owner")) {
    // The scope's delegated approver takes it when it could approve it now; a failed hand-off goes to the person, as without one.
    const delegate = await delegateToHandTo(ctx, companyId, post, state);
    if (delegate) {
      const note = `${intro}Next: the scope's delegated approver. Check the post and approve it with \`approve-post-as-delegate\`, or send it back with notes with \`return-post-as-delegate\`. A person may still approve it on the Social page.`;
      if (await handToDelegate(ctx, companyId, post, delegate, note)) {
        return { completed: false, pending: state.missing, message: `Recorded. Waiting for ${waiting}: handed to the delegated approver.`, delegateAgentId: delegate };
      }
    }
    if (targets.person) handed = await handReviewIssue(ctx, companyId, post, targets.person, `${intro}Next: ${waiting}. Open the post on the Social page → Posts and click Approve.`, "Social post needs a team member's approval");
  }
  // Nobody to hand to (or no open issue): the sign-off still goes on the issue, when there is one.
  if (!handed && lead) {
    const issueId = await reviewIssueOf(ctx, companyId, post.id);
    if (issueId && (await issueOpen(ctx, companyId, issueId))) await ctx.issues.createComment(issueId, `${lead}\n\nStill needed: ${waiting}.`, companyId).catch(() => undefined);
  }
  return { completed: false, pending: state.missing, message: `Recorded. Waiting for ${waiting}.` };
}

/**
 * The delegate a post waiting only for the owner goes to (PAR-9561 T7a), or null (the person gets it). The same conditions the
 * approve tool checks: an active delegate that is not the creator, named before the post was created, and the Reviewer's latest
 * pass is of this version, scored and not the delegate's own. Any read error is null. Never throws.
 */
async function delegateToHandTo(ctx: PluginContext, companyId: string, post: PostRow, state: SignoffState): Promise<string | null> {
  try {
    if (state.missing.length !== 1 || state.missing[0] !== "owner") return null;
    const entry = await delegateForPost(ctx, companyId, post, state.policy);
    if (!entry) return null;
    const rows = await outcomesForPost(ctx, companyId, post.id);
    const pass = rows.filter((row) => row.stage === "reviewer").sort((a, b) => b.round - a.round || String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!pass || pass.outcome !== "approved" || pass.content_hash !== state.hash || pass.via === "unscored") return null;
    if (!pass.actor_agent_id || pass.actor_agent_id === entry.agentId) return null;
    return entry.agentId;
  } catch (error) {
    ctx.logger.info("Social delegate routing skipped; a person approves", { postId: post.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** A person clicks Approve. Needs the policy to ask for a team member, and the Reviewer's pass first when it asks for that. Personal posts can only be approved by the owner. */
export async function approvePostByPerson(ctx: PluginContext, actor: ReviewActor, post: PostRow): Promise<ApprovalProgress> {
  const companyId = actor.companyId;
  requireCanActOnPost(actor, post, "approve");
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

/** A person records that the client approved outside the approval page (an email, a call). A note saying how is required. Personal posts do not have client approval. */
export async function recordClientApprovalByPerson(ctx: PluginContext, actor: ReviewActor, post: PostRow, note: string, by?: string | null): Promise<ApprovalProgress> {
  if (post.scope === "personal") throw new SocialError("Personal posts cannot be submitted for client approval.");
  const companyId = actor.companyId;
  const text = note.trim();
  if (text.length < 10) throw new SocialError("Say how the client approved (who, when and how), at least a few words: it is kept as the approval record.");
  const before = await signoffState(ctx, companyId, post);
  if (!before.policy.requireClient) throw new SocialError("This scope's policy does not ask for the client's approval.");
  if (before.policy.requireReviewer && before.signoffs.reviewer !== "approved") throw new SocialError("The Reviewer has not passed this version yet. Its pass comes first in this scope.");
  await recordSignoff(ctx, companyId, post, before.hash, "client", "approved", "recorded", { userId: actor.userId, name: by ?? null }, text);
  return afterSignoff(ctx, actor, post, withSignoff(before, "client"), "A person, recording the client's approval,", `Record: ${text.slice(0, 300)}`);
}

export interface DelegateCaller {
  companyId: string;
  agentId: string | null;
  isAgent: boolean;
}

function stampOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" && value ? Date.parse(value) : Number.NaN;
}

interface DelegateGate {
  agentId: string;
  scope: ReturnType<typeof scopeOfRow>;
  entry: NonNullable<Awaited<ReturnType<typeof getDelegate>>>;
  policy: ApprovalPolicy;
}

/** Checks 1 to 6 of the delegate's two tools (approve and return), in one place: every refusal is the same for both. */
async function delegateGate(ctx: PluginContext, caller: DelegateCaller, post: PostRow): Promise<DelegateGate> {
  const companyId = caller.companyId;
  // 1. An agent with an id.
  const agentId = caller.isAgent ? caller.agentId : null;
  if (!agentId) throw new SocialError("Only the delegated approver agent uses this tool. People approve on the Social page.");
  // 2. A company post in review.
  if (post.company_id !== companyId) throw new SocialError("Post is not visible");
  if (post.scope === "personal") throw new SocialError("A personal post has no delegated approver: only its owner approves it.");
  if (post.status !== "review") throw new SocialError(`The post is ${post.status.replace("_", " ")}, not in review: there is nothing to approve.`);
  // 3. The scope's delegate is the caller.
  const scope = scopeOfRow(post);
  const entry = await getDelegate(ctx, companyId, scope);
  if (!entry) throw new SocialError("No delegated approver is set for this post's scope, so a person approves it.");
  if (entry.agentId !== agentId) throw new SocialError("You are not the delegated approver for this post's scope. A person approves it.");
  const facts = await delegateFacts(ctx, companyId, scope, agentId);
  // 4. Not the Reviewer (the configured one, paused or not).
  if (facts.configuredReviewerId === undefined) throw new SocialError("The company's roles could not be read, so it is not known who the Reviewer is. Nothing was approved; try again.");
  if (facts.configuredReviewerId === agentId) throw new SocialError("The Reviewer checks the post; it cannot also approve it. A person approves it.");
  // 5. The live policy asks for the owner and not the client (read strictly: an unreadable policy refuses).
  let policy: ApprovalPolicy;
  try {
    policy = await getPolicyStrict(ctx, companyId, scope);
  } catch {
    throw new SocialError("The approval policy could not be read, so nothing was approved. Try again.");
  }
  if (policy.requireClient) throw new SocialError("This scope asks the client to approve; a delegated approver cannot stand in for the client.");
  if (!policy.requireOwner) throw new SocialError("This scope does not ask for a team member's approval, so there is nothing for a delegate to approve.");
  const blockers = delegateBlockers({ ...facts, policy });
  if (blockers.length > 0) throw new SocialError(`The delegated approver cannot act in this scope now: ${blockers[0]} A person approves it.`);
  // 6. Not its own post.
  if (post.created_by_agent_id === agentId) throw new SocialError("You created this post, so you cannot approve it. A person approves it.");
  return { agentId, scope, entry, policy };
}

type DelegateApprovalCheck =
  | { refusal: string }
  | { refusal: null; agentId: string; policy: ApprovalPolicy; hash: string; rows: OutcomeRow[] };

/**
 * Steps 1 to 9 of the delegate's approval, read-only. A refusal is the sentence the approve tool throws; an error that is
 * not a refusal (a failed content read) is thrown as before.
 */
async function delegateApprovalCheck(ctx: PluginContext, caller: DelegateCaller, post: PostRow): Promise<DelegateApprovalCheck> {
  let gate: DelegateGate;
  try {
    gate = await delegateGate(ctx, caller, post);
  } catch (error) {
    if (error instanceof SocialError) return { refusal: error.message };
    throw error;
  }
  const { agentId, entry, policy } = gate;
  // 7. The Reviewer passed THIS version, scored, and the pass was not the caller's (read from the ledger whatever the policy says).
  const { hash } = await postFingerprint(ctx, post);
  let rows: OutcomeRow[];
  try {
    rows = await outcomesForPost(ctx, caller.companyId, post.id);
  } catch {
    return { refusal: "The sign-offs could not be read, so nothing was approved. Try again." };
  }
  const pass = rows.filter((row) => row.stage === "reviewer").sort((a, b) => b.round - a.round || String(b.created_at).localeCompare(String(a.created_at)))[0];
  if (!pass) return { refusal: "The Reviewer has not passed this post yet. Its pass comes first." };
  if (pass.outcome !== "approved") return { refusal: "The Reviewer asked for changes to this post. Return it instead of approving it." };
  if (pass.content_hash !== hash) return { refusal: "The Reviewer passed an older version of this post. It has to pass this version first." };
  if (pass.via === "unscored") return { refusal: "The Reviewer's pass scored nothing (no destination the rubric checks), so a person approves this post." };
  if (!pass.actor_agent_id) return { refusal: "The Reviewer's pass does not say which agent gave it, so a person approves this post." };
  if (pass.actor_agent_id === agentId) return { refusal: "You recorded the Reviewer's pass on this post, so you cannot also approve it. A person approves it." };
  // 9. The post was created after the delegate was named (D3): older posts stay with the person.
  const created = stampOf(post.created_at);
  const setAt = Date.parse(entry.setAt);
  if (!Number.isFinite(created) || !Number.isFinite(setAt) || created < setAt) {
    return { refusal: "This post was created before you were named the delegated approver, so a person approves it." };
  }
  return { refusal: null, agentId, policy, hash, rows };
}

/**
 * Why the caller (the scope's delegated approver) could not approve this post right now, as the sentence
 * `approvePostByDelegate` would refuse with; null when it could. Read-only: the Cockpit uses it to say who a
 * post waits for (PAR-10701). Errors that are not refusals are thrown.
 */
export async function delegateApprovalRefusal(ctx: PluginContext, caller: DelegateCaller, post: PostRow): Promise<string | null> {
  return (await delegateApprovalCheck(ctx, caller, post)).refusal;
}

/**
 * The scope's delegated approver approves a post in review (PAR-9561): its yes is
 * the owner's sign-off. Every check refuses on its own sentence, and every input
 * that cannot be read refuses (a person approves then). The ledger row must be
 * written: it is the only record that an agent approved, so without it nothing
 * is approved. `set-post-status` and `social.approve` stay closed to agents.
 */
export async function approvePostByDelegate(ctx: PluginContext, caller: DelegateCaller, post: PostRow): Promise<ApprovalProgress> {
  const companyId = caller.companyId;
  const check = await delegateApprovalCheck(ctx, caller, post);
  if (check.refusal !== null) throw new SocialError(check.refusal);
  const { agentId, policy, hash, rows } = check;
  // The row is the audit trail: no row, no approval.
  let written = false;
  try {
    written = (await recordOutcome(ctx, { companyId, post, platforms: await platformsOf(ctx, companyId, post), stage: "owner", outcome: "approved", contentHash: hash, via: "delegate", actor: { agentId } })).recorded;
  } catch (error) {
    ctx.logger.warn("Social delegated approval not recorded", { postId: post.id, error: error instanceof Error ? error.message : String(error) });
  }
  if (!written) throw new SocialError("Your approval could not be recorded, so the post was not approved and stays in review. Try again.");
  const signoffs = currentSignoffs(rows, hash);
  const state: SignoffState = { policy, hash, accountIds: [], signoffs, missing: missingStages(policy, signoffs) };
  const actor: ReviewActor = { companyId, userId: null, isAgent: true };
  let progress: ApprovalProgress;
  try {
    progress = await afterSignoff(ctx, actor, post, withSignoff(state, "owner"), "The delegated approver");
  } catch (error) {
    // A lost status race (completeApproval found the post out of review) is not an approval.
    throw new SocialError(`The post was not approved: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!progress.completed) throw new SocialError(`The post was not approved: still waiting for ${stageList(progress.pending)}.`);
  return progress;
}

export interface DelegateReturn {
  returned: boolean;
  next: string;
}

/**
 * The scope's delegated approver sends a post in review back to draft with notes (PAR-9561): the same caller checks as
 * the approval (1 to 6), and notes are required (8). The owner/changes/delegate ledger row carries the notes and must
 * be written; the post then goes back to draft as the Reviewer's return does (`review_returns` counts a person's returns only).
 */
export async function returnPostByDelegate(ctx: PluginContext, caller: DelegateCaller, post: PostRow, rawNotes: string | null | undefined): Promise<DelegateReturn> {
  const companyId = caller.companyId;
  const { agentId } = await delegateGate(ctx, caller, post);
  // 8. Notes are required: the Social agent works from them.
  const notes = (rawNotes ?? "").trim();
  if (!notes) throw new SocialError("Say what has to change (notes): the Social agent works from your list.");
  const { hash } = await postFingerprint(ctx, post);
  let written = false;
  try {
    written = (await recordOutcome(ctx, { companyId, post, platforms: await platformsOf(ctx, companyId, post), stage: "owner", outcome: "changes", contentHash: hash, via: "delegate", actor: { agentId }, note: notes })).recorded;
  } catch (error) {
    ctx.logger.warn("Social delegated return not recorded", { postId: post.id, error: error instanceof Error ? error.message : String(error) });
  }
  if (!written) throw new SocialError("Your return could not be recorded, so the post stays in review. Try again.");
  await sendBackForChanges(ctx, companyId, post, "The delegated approver", notes, false);
  return { returned: true, next: "The post is back in draft and the Social agent has your notes." };
}

export interface VerdictInput {
  agentId: string;
  verdict: "pass" | "changes";
  notes: string | null;
  toneScore?: number | null;
  toneReason?: string | null;
}

/** The Reviewer's verdict on a post in review. Only the company's Reviewer may record it. */
/**
 * Media experiment context for a tagged post, in the shape the kit's `noMediaExempt` expects.
 * `hypothesisType` is cut to "media" and the stored arms control/variant become no_media/media.
 * `noMediaPosts` counts the experiment's control-arm posts in this company. The reviewed post is
 * already stored with its tag, so it is part of the count. A load failure skips the exemption.
 */
export async function mediaExperimentForPost(
  env: GrowthEnv,
  companyId: string,
  post: { experiment_id?: string | null; experiment_arm?: string | null },
): Promise<{ experiment: MediaExperiment | null; arm: string | null }> {
  const storedArm = post.experiment_arm ?? null;
  if (!post.experiment_id) return { experiment: null, arm: storedArm };
  try {
    const exp = await env.store.getExperiment(companyId, post.experiment_id);
    if (!exp || !exp.hypothesisType.startsWith("media:")) return { experiment: null, arm: storedArm };
    const noMediaPosts = await env.store.countArmPosts(companyId, exp.id, "control");
    const arm = storedArm === "control" ? "no_media" : storedArm === "variant" ? "media" : storedArm;
    return {
      experiment: { id: exp.id, status: exp.status, hypothesisType: "media", minPerArm: exp.minPerArm, noMediaPosts },
      arm,
    };
  } catch {
    return { experiment: null, arm: storedArm };
  }
}

/** Days a picture or video stays "used": the same file on another post of the scope inside this time cannot pass review. */
export const MEDIA_REUSE_DAYS = 60;

/**
 * Media of this post that another post of the same scope already carries on one of the same accounts (created inside
 * `MEDIA_REUSE_DAYS`, any status but draft). The same picture on another platform's account is the same content told
 * elsewhere, not a repeat, so it is allowed; a post with no accounts yet is compared with every post of the scope.
 * The two arms of one experiment may share media: there the picture is the thing held constant.
 */
export async function reusedMedia(ctx: PluginContext, companyId: string, post: PostRow): Promise<Array<{ kind: string; day: string; excerpt: string }>> {
  const media = postMedia(post);
  if (media.length === 0) return [];
  // The same scope: own work or the same client; in My Social, the same person's posts.
  const params: unknown[] = [companyId, post.id, post.scope, MEDIA_REUSE_DAYS];
  let who = "p.client_ref IS NULL";
  if (post.client_ref) {
    params.push(post.client_ref);
    who = `p.client_ref = $${params.length}`;
  }
  if (post.scope === "personal") {
    params.push(post.owner_user_id);
    who += ` AND p.owner_user_id = $${params.length}`;
  }
  const accounts = (await destinationsForPost(ctx, post.id)).map((d) => d.account_id);
  if (accounts.length) {
    // The id list goes as JSON text: the host binds an array parameter element by element.
    params.push(JSON.stringify(accounts));
    who += ` AND EXISTS (SELECT 1 FROM ${table(ctx, "destinations")} d WHERE d.post_id = p.id AND d.account_id IN (SELECT jsonb_array_elements_text($${params.length}::jsonb)))`;
  }
  const rows = await ctx.db.query<{ id: string; body: string; media: unknown; created_at: unknown; experiment_id: string | null }>(
    `SELECT p.id, p.body, p.media, p.created_at, p.experiment_id FROM ${table(ctx, "posts")} p
      WHERE p.company_id = $1 AND p.id <> $2 AND p.status <> 'draft' AND p.archived_at IS NULL AND p.scope = $3 AND ${who}
        AND p.created_at >= now() - make_interval(days => $4)
      ORDER BY p.created_at DESC LIMIT 300`,
    params,
  );
  const out: Array<{ kind: string; day: string; excerpt: string }> = [];
  for (const m of media) {
    const other = rows.find((r) => {
      if (post.experiment_id && r.experiment_id === post.experiment_id) return false;
      return postMedia({ media: r.media } as PostRow).some((x) => (m.assetId && x.assetId === m.assetId) || x.url === m.url);
    });
    if (other) out.push({ kind: m.kind === "video" ? "video" : "image", day: new Date(String(other.created_at)).toISOString().slice(0, 10), excerpt: other.body.replace(/\s+/g, " ").trim().slice(0, 60) });
  }
  return out;
}

export async function recordReviewerVerdict(ctx: PluginContext, companyId: string, post: PostRow, input: VerdictInput): Promise<{ recorded: boolean; verdict: string; next: string; refused?: boolean; blockers?: string[]; score?: number; warnings?: string[] }> {
  const reviewer = await reviewerAgentId(ctx, companyId);
  if (!reviewer) throw new SocialError("This company has no Reviewer set (Setup → Team), so there is nobody to record a review verdict.");
  if (reviewer !== input.agentId) throw new SocialError("Only the Reviewer records a review verdict. You draft and send posts for review.");
  if (post.status !== "review") throw new SocialError(`The post is ${post.status.replace("_", " ")}, not in review: there is nothing to check.`);
  const notes = input.notes?.trim() || null;
  if (input.verdict === "changes" && !notes) throw new SocialError("Say what has to change (notes): the Social agent works from your list.");
  const before = await signoffState(ctx, companyId, post);

  // A picture that was on another post cannot pass: a feed that repeats its images looks abandoned.
  if (input.verdict === "pass") {
    const reused = await reusedMedia(ctx, companyId, post);
    if (reused.length) {
      const blockers = reused.map((r) => `The ${r.kind} was already used on a post of ${r.day} ("${r.excerpt}"). Make a new one that shows what this post says.`);
      return { recorded: false, verdict: "pass", refused: true, blockers, next: "Not recorded: this post reuses a picture or video. Return it with record-review-verdict verdict changes, and ask for new media (request-creative)." };
    }
  }

  // For "pass", run the creative rubric and check media rule enforcement
  if (input.verdict === "pass") {
    const { scoreCreative } = await import("@partnersinbiz/pib-plugin-kit");
    const destinations = await destinationsForPost(ctx, post.id);
    const accounts = await getAccountsByIds(ctx, companyId, destinations.map((d) => d.account_id));
    const platforms = accounts.map((a) => a.platform).filter((p): p is "linkedin" | "instagram" | "facebook" | "x" | "email" | "web" => ["linkedin", "instagram", "facebook", "x", "email", "web"].includes(p));

    // No destinations the rubric covers: the pass is recorded as unscored (a later account makes it stale) and the warning stays
    if (platforms.length === 0) {
      const written = await recordSignoff(ctx, companyId, post, before.hash, "reviewer", "approved", "unscored", { agentId: input.agentId }, notes);
      if (!written) {
        return { recorded: false, verdict: "pass", next: "The pass could not be recorded. Try again.", warnings: ["No destinations to check"] };
      }
      const actor: ReviewActor = { companyId, userId: null, isAgent: true };
      const progress = await afterSignoff(ctx, actor, post, withSignoff(before, "reviewer"), "A person");
      return {
        recorded: true,
        verdict: "pass",
        next: progress.completed ? "No destinations to check: the post is approved." : `No destinations to check. Handed on: ${stageList(progress.pending)} still has to approve. Add accounts if needed.`,
        warnings: ["No destinations to check"],
      };
    }

    // Get the post's media and parse it
    const media = (post.media as Array<{ kind?: string; altText?: string | null; durationSec?: number | null }> | unknown) || [];
    const mediaArray = Array.isArray(media) ? media : [];

    // Load the effective media rule for the post's scope
    const env = growthEnv(ctx);
    const scope = scopeOfRow(post);
    const { rule: mediaRule, loadError: rubricLoadError } = await effectiveMediaRule(env, companyId, scope);

    // Fail closed: if playbook load threw and verdict is pass, refuse (same shape as experiment-load failure)
    if (rubricLoadError) {
      return {
        recorded: false,
        verdict: "pass",
        refused: true,
        blockers: ["media rule could not be loaded"],
        next: "The media rule could not be loaded. Reload and retry record-review-verdict to check again.",
      };
    }

    // Check if post is text-native based on tags
    const postOverrides = post.overrides as Record<string, unknown> | null | undefined;
    const postTags = (postOverrides?.tags as string[] | null | undefined) || [];
    const textNative = Array.isArray(postTags) && postTags.includes("text-native");

    // Load experiment if tagged (for control arm exemption)
    const { experiment: mediaExperiment, arm: experimentArmName } = await mediaExperimentForPost(env, companyId, post);

    // Score the post for each platform and aggregate all blockers
    let minScore = 100;
    let allBlockers: Map<string, string> = new Map(); // blocker text -> platform list
    let allWarnings: Set<string> = new Set();

    for (const platform of platforms) {
      const platformOverrides = postOverrides?.[platform] as Record<string, string> | undefined;
      const result = scoreCreative({
        platform,
        text: platformOverrides?.text ?? post.body ?? "",
        media: mediaArray,
        mediaRule,
        textNative,
        experimentId: post.experiment_id ?? null,
        arm: experimentArmName ?? null,
        experiment: mediaExperiment,
        tone: input.toneScore != null && input.toneReason?.trim() ? { score: input.toneScore, source: "reviewer", reason: input.toneReason } : (input.toneScore != null ? { score: input.toneScore, source: "reviewer" } : null),
      });

      minScore = Math.min(minScore, result.score);
      result.blockers.forEach((b) => {
        const key = b.text;
        const current = allBlockers.get(key) || "";
        allBlockers.set(key, current ? `${current}, ${platform}` : platform);
      });
      result.notes.forEach((w) => allWarnings.add(w));
    }

    // Format blockers: include platform prefix when multiple platforms have blockers
    const blockersArray = Array.from(allBlockers.entries()).map(([text, platforms]) =>
      platforms.split(", ").length === 1 ? text : `${text} (${platforms})`
    );

    const canPass = minScore >= 80 && blockersArray.length === 0;
    const shouldBlock = mediaRule.enforce === "block" && !canPass;

    // If rubric failed to load in block mode, use DEFAULT_MEDIA_RULE (advise) + warning + pass
    // If in block mode and can't pass, refuse
    if (shouldBlock) {
      const nextAction = blockersArray.length > 0
        ? `Fix these blockers with update-post and attach media with alt text if needed, then request review again: ${blockersArray.join("; ")}.`
        : `Address the scoring issues and request review again. Score: ${minScore}.`;
      return {
        recorded: false,
        verdict: "pass",
        refused: true,
        blockers: blockersArray,
        score: minScore,
        next: nextAction,
      };
    }

    // Record the pass and include score and warnings
    const written = await recordSignoff(ctx, companyId, post, before.hash, "reviewer", "approved", "tool", { agentId: input.agentId }, notes);
    if (!written) {
      return { recorded: false, verdict: "pass", score: minScore, next: "The pass could not be recorded. Try again." };
    }
    const actor: ReviewActor = { companyId, userId: null, isAgent: true };
    const progress = await afterSignoff(ctx, actor, post, withSignoff(before, "reviewer"), "A person");

    const warnings = Array.from(allWarnings);
    if (rubricLoadError) {
      warnings.push(rubricLoadError);
    }

    return {
      recorded: true,
      verdict: "pass",
      score: minScore,
      warnings: warnings.length > 0 ? warnings : undefined,
      next: progress.completed
        ? "Nothing else was needed: the post is approved."
        : progress.delegateAgentId
          ? `Handed on to the scope's delegated approver (agent \`${progress.delegateAgentId}\`), who approves or returns it. Nothing is posted until then.`
          : `Handed on: ${stageList(progress.pending)} still has to approve. Nothing is posted until then.`,
    };
  }

  // For "changes", don't run the rubric
  const changesWritten = await recordSignoff(ctx, companyId, post, before.hash, "reviewer", "changes", "tool", { agentId: input.agentId }, notes);
  await sendBackForChanges(ctx, companyId, post, "The Reviewer", notes ?? "", false);
  return { recorded: changesWritten, verdict: "changes", next: "The post is back in draft and the Social agent has your notes." };
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
  const text = `${who} asked for changes:\n\n> ${notes.replace(/\n/g, "\n> ")}\n\nThe post is back in draft. Fix every point, then send it for review again (\`request-review\`). If the problem is the image or video (missing, off-brand, wrong format, no alt text), call \`request-creative\` for this post first: it opens the hand-off for whoever makes the asset.`;
  // The note has to reach the Social agent even when its review issue was closed or never opened: handToSocialAgent opens a fresh one then.
  await handToSocialAgent(ctx, companyId, post, { task: "changes", note: text, wakeReason: "Changes requested on a social post" });
}

/** The longest change note a person can send from the page. */
export const MAX_CHANGE_NOTE = 2000;

export interface PersonChanges {
  /** The Social agent (or whoever does its work) got the note on the post's issue. */
  handed: boolean;
  /** The status the post had before; it is a draft now. */
  from: PostRow["status"];
  /** What happens next, in plain words, for the page. */
  next: string;
}

/**
 * A person on the Social page says what to change on a post, and the note goes to the Social agent (the post's own issue,
 * woken). Works on a draft, a post in review, and an approved or scheduled post; every one of them ends as a draft, so
 * nothing publishes before the change is made and approved again. The note is also an owner/changes row in the ledger
 * (the review statistics the agents read). `remember` adds the instruction to keep it as a playbook rule.
 */
export async function requestChangesByPerson(
  ctx: PluginContext,
  actor: ReviewActor,
  post: PostRow,
  rawNotes: string | null | undefined,
  options: { remember?: boolean } = {},
): Promise<PersonChanges> {
  const companyId = actor.companyId;
  if (actor.isAgent || !actor.userId) throw new SocialError("A person sends changes from the Social page. Agents use record-review-verdict or return-post-as-delegate.");
  if (post.scope === "personal") throw new SocialError("My Social posts are yours alone: edit the post yourself.");
  const notes = (rawNotes ?? "").trim();
  if (!notes) throw new SocialError("Say what has to change: the Social agent works from your note.");
  if (notes.length > MAX_CHANGE_NOTE) throw new SocialError(`Keep the note under ${MAX_CHANGE_NOTE} characters.`);
  const from = post.status;
  if (from !== "draft" && from !== "review" && from !== "approved" && from !== "scheduled") {
    throw new SocialError(`A ${from.replace("_", " ")} post cannot be sent back for changes.`);
  }
  const { hash } = await postFingerprint(ctx, post);
  const lasting = options.remember
    ? "\n\nThis is a lasting preference, not only a fix for this post: read the playbook (`get-playbook`) and propose it as a rule (`propose-playbook-change`, with this note as the reason) so later posts follow it."
    : "";
  if (from === "review") {
    await recordSignoff(ctx, companyId, post, hash, "owner", "changes", "ui", { userId: actor.userId }, notes);
    await closeWeeklyReviewItem(ctx, companyId, post.id, "The post went back to draft for changes. A new review opens when it is sent for review again.").catch(() => undefined);
    await sendBackForChanges(ctx, companyId, post, "A team member", `${notes}${lasting}`, true);
    const now = await getPost(ctx, companyId, post.id);
    if (now?.status !== "draft") throw new SocialError("The post changed while you were writing. Reload and try again.");
    return { handed: Boolean(await reviewIssueOf(ctx, companyId, post.id)), from, next: "The post is back in draft and the Social agent has your note." };
  }
  if (from !== "draft" && !(await setPostStatus(ctx, companyId, post.id, [from], "draft"))) {
    throw new SocialError("The post changed while you were writing (it may be publishing now). Reload and try again.");
  }
  if (from !== "draft") await supersedePendingLinks(ctx, companyId, post.id);
  await recordSignoff(ctx, companyId, post, hash, "owner", "changes", "ui", { userId: actor.userId }, notes);
  const moved = from === "draft" ? "The post is a draft." : `The post was ${from} and is back in draft, so it does not publish until it is approved again.`;
  const text = `A team member asked for changes:\n\n> ${notes.replace(/\n/g, "\n> ")}${lasting}\n\n${moved} Fix every point, then send it for review again (\`request-review\`). If the problem is the image or video, call \`request-creative\` for this post first.`;
  const issueId = await handToSocialAgent(ctx, companyId, { ...post, status: "draft" }, { task: "changes", note: text, wakeReason: "Changes requested on a social post" });
  return {
    handed: Boolean(issueId),
    from,
    next: issueId ? "The Social agent has your note and the post is in draft." : "The post is in draft, but no Social agent or person could be given the note. Link a Social agent on the Overview tab, or edit the post yourself.",
  };
}

/** One change request on a post, for the page. */
export interface ChangeNote {
  stage: Stage;
  by: string;
  note: string;
  at: string | null;
}

/** The change requests a post has had (Reviewer, team, delegated approver, client), newest first. Never throws. */
export async function changeNotesFor(ctx: PluginContext, companyId: string, postId: string): Promise<ChangeNote[]> {
  const rows = await outcomesForPost(ctx, companyId, postId).catch(() => [] as OutcomeRow[]);
  return rows
    .filter((row) => row.outcome === "changes" && row.note?.trim())
    .map((row) => ({
      stage: row.stage,
      by: row.stage === "reviewer" ? "The Reviewer" : row.stage === "client" ? row.actor_name?.trim() || "The client" : row.via === "delegate" ? "The delegated approver" : "A team member",
      note: row.note as string,
      at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at ? String(row.created_at) : null,
    }));
}

/**
 * A person cleared the scope's delegated approver (PAR-9561 T7b, findings 13): the review issue it holds for this post goes back
 * to the person, as without a delegate. Only an issue that matches "post in review, current pass in, owner missing, assignee = the
 * cleared delegate"; any other issue the agent holds (a changes-requested draft, a client link) is left alone. Returns true when it
 * handed the issue back. Read errors throw: the caller counts the post as failed.
 */
export async function handBackFromDelegate(ctx: PluginContext, actor: ReviewActor, post: PostRow, state: SignoffState, agentId: string): Promise<boolean> {
  const companyId = actor.companyId;
  if (post.status !== "review" || state.signoffs.reviewer !== "approved" || !state.missing.includes("owner")) return false;
  const issueId = await reviewIssueOf(ctx, companyId, post.id);
  if (!issueId) return false;
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue || issue.assigneeAgentId !== agentId || !(await issueOpen(ctx, companyId, issueId))) return false;
  // A matching issue that cannot go back is a failure, not a skip: the cleared delegate would keep work its tool now refuses.
  const targets = await handoffTargets(ctx, companyId, post);
  if (!targets.person) throw new Error("no team member to hand the review issue back to");
  const note = `The delegated approver was cleared, so a team member approves this post now. Next: ${stageList(state.missing)}. Open the post on the Social page → Posts and click Approve.`;
  if (!(await handReviewIssue(ctx, companyId, post, targets.person, note, "Social post needs a team member's approval"))) throw new Error("the review issue was not handed back");
  return true;
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
