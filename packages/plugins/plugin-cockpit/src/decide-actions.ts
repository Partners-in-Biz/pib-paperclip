/**
 * The Decide tab's three actions (PAR-15315, T2): the owner clicks a choice and the Cockpit resolves the real record,
 * acting as that person.
 *
 * - `decide.ask {askId, option}`: answers a Cockpit ask (`answerAskInline`); the answer goes on the issue as the
 *   owner's comment.
 * - `decide.approval {approvalId, action, note?}`: approves or rejects a `request_board_approval` or
 *   `approve_ceo_strategy` approval. `hire_agent` and `budget_override_required` are refused (they are "Open" only).
 * - `decide.card {issueId, interactionId, action}`: accepts or rejects a `request_confirmation` card addressed to
 *   nobody or the owner.
 *
 * Every host call that acts as a person (`approvals.decide`, `respondInteraction`, `createComment` with
 * `actorUserId`) lives in this file and nowhere else in src/ (`tests/act-as-person.spec.ts`). The host re-checks that
 * the person is an active, non-viewer member; it does NOT check that the item is theirs. That narrowing is here:
 * only the company's owner (`roles.ownerUserId`), signed in as a person, gets past `requireOwner`. Each action re-reads
 * its record before it writes: an item that is no longer pending answers `already_decided` and nothing is written.
 */
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { answerAskInline, getAsk, type InlineAnswerOutcome, type PostAsUser } from "./asks.js";
import { assignableUser } from "./constants.js";
import { getRoles } from "./db.js";
import { clearDecideCache } from "./decide.js";
import { approvalMode, cardMode } from "./decide-model.js";
import { CockpitError, message, type Env } from "./env.js";

export type DecideOutcome = InlineAnswerOutcome;
export interface DecideResult {
  result: DecideOutcome;
}

const NOTE_MAX = 1_000;

function text(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || !value.trim()) throw new CockpitError(`${field} is required`);
  return value.trim().slice(0, max);
}

/**
 * The caller must be the company's owner, signed in as a person. Agent keys and run tokens reach the worker as
 * `type: "agent", userId: null`; the local board user is nobody's owner. The acting-person fields the host spreads into
 * the actor are never read. An owner lookup that fails refuses (fails closed).
 */
export async function requireOwner(env: Env, context: PluginPerformActionContext): Promise<{ companyId: string; userId: string }> {
  const companyId = context.companyId;
  if (!companyId) throw new CockpitError("Company is required");
  const actor = context.actor;
  if (!actor || actor.type !== "user") throw new CockpitError("Only the owner, signed in, can decide from this queue");
  const caller = assignableUser(typeof actor.userId === "string" ? actor.userId : null);
  if (!caller) throw new CockpitError("Only the owner, signed in, can decide from this queue");
  let owner: string | null;
  try {
    owner = assignableUser((await getRoles(env.ctx, companyId))?.ownerUserId ?? null);
  } catch (error) {
    env.ctx.logger.info("Decide: the owner could not be read, so the action is refused", { companyId, error: message(error) });
    throw new CockpitError("Could not check who owns this company; nothing was decided. Try again.");
  }
  if (!owner || owner !== caller) throw new CockpitError("This queue is the owner's: only the owner can decide from it");
  return { companyId, userId: caller };
}

/** The owner's answer as a comment by the owner (the one `createComment` with `actorUserId` in src/, bar `cockpit.start-hire`). */
function postAsUserFor(env: Env, companyId: string, userId: string): PostAsUser {
  return async (issueId, answer) => {
    const comment = await env.ctx.issues.createComment(issueId, `${answer}\n\n_Answered in Cockpit → Decide._`, companyId, { actorUserId: userId });
    return comment?.id ?? null;
  };
}

export async function decideAsk(env: Env, params: Record<string, unknown>, context: PluginPerformActionContext): Promise<DecideResult> {
  const { companyId, userId } = await requireOwner(env, context);
  const askId = text(params.askId, "askId", 100);
  if (typeof params.option !== "string" || !params.option) throw new CockpitError("option is required");
  const option = params.option;
  const ask = await getAsk(env, companyId, askId);
  if (!ask || ask.status !== "open") return { result: "already_decided" };
  // An ask routed to another person is theirs, even in the owner's company.
  const askOwner = assignableUser(ask.ownerUserId);
  if (ask.ownerUserId && askOwner !== userId) throw new CockpitError("This question is for someone else: only they can answer it");
  try {
    return { result: await answerAskInline(env, companyId, askId, option, userId, postAsUserFor(env, companyId, userId)) };
  } finally {
    clearDecideCache(companyId);
  }
}

export async function decideApproval(env: Env, params: Record<string, unknown>, context: PluginPerformActionContext): Promise<DecideResult> {
  const { companyId, userId } = await requireOwner(env, context);
  const approvalId = text(params.approvalId, "approvalId", 100);
  const action = params.action;
  if (action !== "approve" && action !== "reject") throw new CockpitError("action must be approve or reject");
  const note = typeof params.note === "string" && params.note.trim() ? params.note.trim().slice(0, NOTE_MAX) : null;
  try {
    const approval = await env.ctx.approvals.get(approvalId, companyId);
    if (!approval || approval.status !== "pending") return { result: "already_decided" };
    // Hires and budget overrides create an agent or move money: a one-line card cannot show enough (plan Q&A 10).
    if (approvalMode(String(approval.type), "pending") !== "decide") throw new CockpitError(`A ${String(approval.type).replace(/_/g, " ")} approval is decided on its own page, not from this queue`);
    const out = await env.ctx.approvals.decide(approvalId, { action, actorUserId: userId, decisionNote: note }, companyId);
    return { result: out.applied ? "ok" : "already_decided" };
  } finally {
    clearDecideCache(companyId);
  }
}

export async function decideCard(env: Env, params: Record<string, unknown>, context: PluginPerformActionContext): Promise<DecideResult> {
  const { companyId, userId } = await requireOwner(env, context);
  const issueId = text(params.issueId, "issueId", 100);
  const interactionId = text(params.interactionId, "interactionId", 100);
  const action = params.action;
  if (action !== "accept" && action !== "reject") throw new CockpitError("action must be accept or reject");
  const note = typeof params.note === "string" && params.note.trim() ? params.note.trim().slice(0, NOTE_MAX) : null;
  try {
    const cards = await env.ctx.issues.listInteractions(issueId, companyId);
    const card = cards.find((c) => c.id === interactionId);
    if (!card || card.status !== "pending") return { result: "already_decided" };
    const c = card as unknown as { kind: string; status: string; addresseeUserId?: string | null; addresseeAgentId?: string | null; payload?: Record<string, unknown> | null };
    const mode = cardMode({ kind: c.kind, status: c.status, addresseeUserId: c.addresseeUserId ?? null, addresseeAgentId: c.addresseeAgentId ?? null }, userId);
    if (mode === null) throw new CockpitError("This card is for someone else: only they can answer it");
    if (mode !== "decide") throw new CockpitError("This kind of card is answered on its task, not from this queue");
    if (action === "reject" && !note && c.payload?.rejectRequiresReason === true) throw new CockpitError("This card needs a reason to reject it: open the task to give one");
    const out = await env.ctx.issues.respondInteraction(issueId, interactionId, { action, actorUserId: userId, reason: note }, companyId);
    return { result: out.applied ? "ok" : "already_decided" };
  } finally {
    clearDecideCache(companyId);
  }
}
