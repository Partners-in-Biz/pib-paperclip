/**
 * `ask-owner`: an agent asks the owner for a decision, a one-time grant,
 * money, legal or information it cannot get elsewhere (kit "Asking a person").
 *
 * - The ask is stored (one open ask per issue; asking again updates it), a
 *   clear comment goes on the issue, and the issue goes to the owner with
 *   status `in_review`: in Paperclip that is the healthy "waiting on a
 *   person" state (a board user reviewing), and it puts the issue in the
 *   owner's inbox. `blocked` would mean a dependency, not a person.
 * - The owner's reply (any board user's comment) is the answer: the issue
 *   goes back to the agent that worked on it (status `todo`) and that agent
 *   is woken with the answer in the wake reason.
 * - Closing the issue resolves (done) or cancels the ask; handing it to an
 *   agent without a reply resolves it too. An hourly check catches missed
 *   events.
 */
import type { PluginEvent, ToolRunContext } from "@paperclipai/plugin-sdk";
import { askAnsweredKey, askCardProblems, askEffectComment, askEffectKeys, emitAskAnswered, runAskEffect, type AskAnswered, type AskEffectResult } from "@partnersinbiz/pib-plugin-kit";
import { recordActivity } from "./activity.js";
import { askComment, AskError, ASK_LIMITS, describeEffect, INTERNAL_EFFECTS, parseAskInput, wakeReason, type AskEffect, type AskInput, type AskKind, type AskView } from "./ask-model.js";
import { crmClient } from "./clients.js";
import { assignableUser } from "./constants.js";
import { getRoles } from "./db.js";
import { message, type Env } from "./env.js";
import { NAMESPACE } from "./namespace.js";
import { currentRoles, routeFromRoles } from "./roles.js";

const TABLE = `${NAMESPACE}.asks`;
const CLOSED = new Set(["done", "cancelled"]);
const GONE = new Set(["terminated", "archived", "deleted"]);

export const NO_OWNER_MESSAGE =
  "Nobody receives questions yet: this company has no owner set (Setup → Team → Who gets the daily brief). Say on the issue exactly what you need and from whom, set the issue to blocked, and carry on with other work. The Cockpit shows a health warning so the owner gets set.";

export type AskStatus = "open" | "answered" | "resolved" | "cancelled";

export interface AskRow {
  id: string;
  companyId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string | null;
  agentId: string | null;
  returnAgentId: string | null;
  runId: string | null;
  question: string;
  options: string[];
  why: string | null;
  kind: AskKind;
  links: Array<{ label: string; href: string }>;
  steps: string[];
  clientRef: string | null;
  dueBy: string | null;
  ownerUserId: string | null;
  status: AskStatus;
  commentId: string | null;
  answer: string | null;
  answerCommentId: string | null;
  answeredByUserId: string | null;
  askedCount: number;
  askedAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** `agent`: asked with ask-owner. `cockpit`: a question the Cockpit asks itself (a grant, goals to adopt). */
  source: "agent" | "cockpit";
  /** What a yes does (kit ask-effects), and where it stands. */
  effect: AskEffect | null;
  effectKey: string | null;
  effectStatus: string | null;
  effectDetail: string | null;
  effectAnnouncedAt: string | null;
  effectAnnouncedCount: number;
  effectResultAt: string | null;
  handedBackAt: string | null;
}

const COLUMNS =
  "id, company_id, issue_id, issue_identifier, issue_title, agent_id, return_agent_id, run_id, question, options, why, kind, links, steps, client_ref, due_by, owner_user_id, status, comment_id, answer, answer_comment_id, answered_by_user_id, asked_count, asked_at, updated_at, closed_at, source, effect, effect_key, effect_status, effect_detail, effect_announced_at, effect_announced_count, effect_result_at, handed_back_at";

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : "";
}

function str(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function rowFrom(raw: Record<string, unknown>): AskRow {
  return {
    id: String(raw.id),
    companyId: String(raw.company_id),
    issueId: String(raw.issue_id),
    issueIdentifier: str(raw.issue_identifier),
    issueTitle: str(raw.issue_title),
    agentId: str(raw.agent_id),
    returnAgentId: str(raw.return_agent_id),
    runId: str(raw.run_id),
    question: String(raw.question ?? ""),
    options: json<string[]>(raw.options, []).filter((o) => typeof o === "string"),
    why: str(raw.why),
    kind: (["decision", "grant", "money", "legal", "info"].includes(String(raw.kind)) ? String(raw.kind) : "decision") as AskKind,
    links: json<Array<{ label: string; href: string }>>(raw.links, []),
    steps: json<string[]>(raw.steps, []),
    clientRef: str(raw.client_ref),
    dueBy: str(raw.due_by),
    ownerUserId: str(raw.owner_user_id),
    status: String(raw.status ?? "open") as AskStatus,
    commentId: str(raw.comment_id),
    answer: str(raw.answer),
    answerCommentId: str(raw.answer_comment_id),
    answeredByUserId: str(raw.answered_by_user_id),
    askedCount: Number(raw.asked_count ?? 1) || 1,
    askedAt: iso(raw.asked_at),
    updatedAt: iso(raw.updated_at),
    closedAt: raw.closed_at == null ? null : iso(raw.closed_at),
    source: String(raw.source) === "cockpit" ? "cockpit" : "agent",
    effect: (() => {
      const e = json<AskEffect | null>(raw.effect, null);
      return e && typeof e.key === "string" ? e : null;
    })(),
    effectKey: str(raw.effect_key),
    effectStatus: str(raw.effect_status),
    effectDetail: str(raw.effect_detail),
    effectAnnouncedAt: raw.effect_announced_at == null ? null : iso(raw.effect_announced_at),
    effectAnnouncedCount: Number(raw.effect_announced_count ?? 0) || 0,
    effectResultAt: raw.effect_result_at == null ? null : iso(raw.effect_result_at),
    handedBackAt: raw.handed_back_at == null ? null : iso(raw.handed_back_at),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export async function openAskForIssue(env: Env, companyId: string, issueId: string): Promise<AskRow | null> {
  const rows = await env.ctx.db.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM ${TABLE} WHERE company_id = $1 AND issue_id = $2 AND status = 'open' LIMIT 1`, [companyId, issueId]);
  return rows[0] ? rowFrom(rows[0]) : null;
}

export async function listOpenAsks(env: Env, companyId: string, limit = 50): Promise<AskRow[]> {
  const rows = await env.ctx.db.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM ${TABLE} WHERE company_id = $1 AND status = 'open' ORDER BY asked_at LIMIT $2`, [companyId, limit]);
  return rows.map(rowFrom);
}

export async function getAsk(env: Env, companyId: string, id: string): Promise<AskRow | null> {
  const rows = await env.ctx.db.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM ${TABLE} WHERE company_id = $1 AND id = $2`, [companyId, id]);
  return rows[0] ? rowFrom(rows[0]) : null;
}

export async function insertAsk(env: Env, row: AskRow): Promise<void> {
  await env.ctx.db.execute(
    `INSERT INTO ${TABLE} (id, company_id, issue_id, issue_identifier, issue_title, agent_id, return_agent_id, run_id, question, options, why, kind, links, steps, client_ref, due_by, owner_user_id, status, asked_at, updated_at, source, effect)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22::jsonb)`,
    [
      row.id, row.companyId, row.issueId, row.issueIdentifier, row.issueTitle, row.agentId, row.returnAgentId, row.runId, row.question, JSON.stringify(row.options), row.why, row.kind,
      JSON.stringify(row.links), JSON.stringify(row.steps), row.clientRef, row.dueBy, row.ownerUserId, "open", row.askedAt, row.updatedAt, row.source, row.effect ? JSON.stringify(row.effect) : null,
    ],
  );
}

/** Asking again on the same issue: the new question replaces the old one; the age counts from the first ask. */
async function updateOpenAsk(env: Env, ask: AskRow, input: AskInput, agentId: string, runId: string | null, ownerUserId: string, now: string): Promise<void> {
  await env.ctx.db.execute(
    `UPDATE ${TABLE} SET question = $3, options = $4::jsonb, why = $5, kind = $6, links = $7::jsonb, steps = $8::jsonb, client_ref = $9, due_by = $10, owner_user_id = $11, agent_id = $12, run_id = $13, asked_count = $14, updated_at = $15, effect = $16::jsonb
      WHERE company_id = $1 AND id = $2 AND status = 'open'`,
    [ask.companyId, ask.id, input.question, JSON.stringify(input.options), input.why, input.kind, JSON.stringify(input.links), JSON.stringify(input.steps), input.client ?? ask.clientRef, input.dueBy, ownerUserId, agentId, runId, ask.askedCount + 1, now, input.effect ? JSON.stringify(input.effect) : null],
  );
}

export async function setCommentId(env: Env, ask: Pick<AskRow, "companyId" | "id">, commentId: string | null): Promise<void> {
  if (!commentId) return;
  await env.ctx.db.execute(`UPDATE ${TABLE} SET comment_id = $3 WHERE company_id = $1 AND id = $2`, [ask.companyId, ask.id, commentId]);
}

/** Closes an open ask; false when it was already closed (another event got there first). */
async function closeAsk(env: Env, ask: AskRow, patch: { status: Exclude<AskStatus, "open">; answer?: string | null; answerCommentId?: string | null; answeredByUserId?: string | null }, now: string): Promise<boolean> {
  const result = await env.ctx.db.execute(
    `UPDATE ${TABLE} SET status = $3, answer = $4, answer_comment_id = $5, answered_by_user_id = $6, closed_at = $7, updated_at = $8 WHERE company_id = $1 AND id = $2 AND status = 'open'`,
    [ask.companyId, ask.id, patch.status, patch.answer ?? null, patch.answerCommentId ?? null, patch.answeredByUserId ?? null, now, now],
  );
  return (result.rowCount ?? 0) > 0;
}

export function newAskId(): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "q";
  for (let i = 0; i < 12; i += 1) out += alphabet[Math.floor(Math.random() * 32)];
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function agentName(env: Env, companyId: string, agentId: string | null): Promise<string | null> {
  if (!agentId) return null;
  const agent = await env.ctx.agents.get(agentId, companyId).catch(() => null);
  return agent ? String(agent.name ?? "") || null : null;
}

async function usableAgent(env: Env, companyId: string, agentId: string | null): Promise<{ id: string; name: string } | null> {
  if (!agentId) return null;
  const agent = await env.ctx.agents.get(agentId, companyId).catch(() => null);
  if (!agent || GONE.has(String(agent.status))) return null;
  return { id: agent.id, name: String(agent.name ?? "the agent") };
}

async function prefixOf(env: Env, companyId: string): Promise<string | null> {
  return (await env.ctx.companies.get(companyId).catch(() => null))?.issuePrefix ?? null;
}

async function clientLabel(env: Env, companyId: string, ref: string | null): Promise<string | null> {
  if (!ref) return null;
  const client = await crmClient(env.ctx, companyId, ref).catch(() => null);
  return client?.name ? `${client.name} (${ref})` : ref;
}

// ---------------------------------------------------------------------------
// ask-owner
// ---------------------------------------------------------------------------

export interface AskOwnerResult {
  askId: string;
  issueId: string;
  identifier: string | null;
  href: string;
  status: "asked" | "updated";
  handedToOwner: boolean;
  next: string;
}

/** The tool. Throws AskError with a message the agent can act on. */
export async function askOwner(env: Env, run: Pick<ToolRunContext, "agentId" | "runId" | "companyId">, raw: Record<string, unknown>): Promise<AskOwnerResult> {
  const companyId = run.companyId;
  const input = parseAskInput(raw);
  const agentId = run.agentId ?? null;
  if (!agentId) throw new AskError("Only an agent can ask the owner with this tool.");
  if (input.effect) {
    if (INTERNAL_EFFECTS.has(input.effect.key)) throw new AskError(`${input.effect.key} is not an effect an agent may ask for: only the Cockpit's own questions use it.`);
    if (input.effect.key.startsWith("cockpit.") && !askEffectKeys().includes(input.effect.key)) throw new AskError(`${input.effect.key} is not an effect the Cockpit knows.`);
  }
  // A card with no deep link, a grant with no steps, or an effect on a money question is refused here, so the owner never has to hunt for the screen.
  const problems = askCardProblems({ kind: input.kind, links: input.links, steps: input.steps, effect: input.effect });
  if (problems.length > 0) throw new AskError(`The question is not ready to send:\n- ${problems.join("\n- ")}`);
  const issue = await env.ctx.issues.get(input.issueId, companyId).catch(() => null);
  if (!issue) throw new AskError(`Issue ${input.issueId} was not found in this company. Pass the issue you are working on (id or identifier, e.g. PIB-23).`);
  if (CLOSED.has(String(issue.status))) throw new AskError(`Issue ${issue.identifier ?? issue.id} is closed. Ask on an open issue: the one waiting for the answer.`);
  const now = env.now().toISOString();
  const roles = await getRoles(env.ctx, companyId);
  const owner = assignableUser(roles?.ownerUserId ?? null);
  if (!owner) {
    await recordActivity(env.ctx, companyId, {
      key: `ask-refused:${issue.id}`,
      kind: "ask_refused",
      at: now,
      text: `A question on ${issue.identifier ?? "an issue"} could not reach anyone: no owner is set.`,
      href: `/issues/${issue.identifier ?? issue.id}`,
      agentId,
    }).catch(() => false);
    throw new AskError(NO_OWNER_MESSAGE);
  }

  const existing = await openAskForIssue(env, companyId, issue.id);
  // The issue goes back to whoever worked on it: its agent when it has one, else the agent asking.
  const holder = issue.assigneeAgentId && !issue.assigneeUserId ? issue.assigneeAgentId : null;
  let ask: AskRow;
  if (existing) {
    await updateOpenAsk(env, existing, input, agentId, run.runId ?? null, owner, now);
    ask = (await getAsk(env, companyId, existing.id)) ?? existing;
  } else {
    ask = {
      id: newAskId(),
      companyId,
      issueId: issue.id,
      issueIdentifier: issue.identifier ?? null,
      issueTitle: issue.title ?? null,
      agentId,
      returnAgentId: holder ?? agentId,
      runId: run.runId ?? null,
      question: input.question,
      options: input.options,
      why: input.why,
      kind: input.kind,
      links: input.links,
      steps: input.steps,
      clientRef: input.client,
      dueBy: input.dueBy,
      ownerUserId: owner,
      status: "open",
      commentId: null,
      answer: null,
      answerCommentId: null,
      answeredByUserId: null,
      askedCount: 1,
      askedAt: now,
      updatedAt: now,
      closedAt: null,
      source: "agent",
      effect: input.effect,
      effectKey: null,
      effectStatus: null,
      effectDetail: null,
      effectAnnouncedAt: null,
      effectAnnouncedCount: 0,
      effectResultAt: null,
      handedBackAt: null,
    };
    try {
      await insertAsk(env, ask);
    } catch (error) {
      // Two asks at once on the same issue: the other one won; update it instead.
      const raced = await openAskForIssue(env, companyId, issue.id);
      if (!raced) throw error;
      await updateOpenAsk(env, raced, input, agentId, run.runId ?? null, owner, now);
      ask = (await getAsk(env, companyId, raced.id)) ?? raced;
    }
  }

  const [prefix, returnName, askerName, label] = await Promise.all([
    prefixOf(env, companyId),
    agentName(env, companyId, ask.returnAgentId ?? agentId),
    agentName(env, companyId, agentId),
    clientLabel(env, companyId, ask.clientRef),
  ]);
  const body = askComment({ ask: input, agentName: returnName ?? "the agent", from: askerName, clientLabel: label, prefix, again: !!existing });
  const comment = await env.ctx.issues.createComment(issue.id, body, companyId, { authorAgentId: agentId });
  await setCommentId(env, ask, String((comment as { id?: unknown }).id ?? "") || null);

  let handedToOwner = true;
  if (issue.assigneeUserId !== owner || issue.assigneeAgentId || issue.status !== "in_review") {
    try {
      await env.ctx.issues.update(issue.id, { assigneeAgentId: null, assigneeUserId: owner, status: "in_review" }, companyId);
    } catch (error) {
      handedToOwner = false;
      env.ctx.logger.info("ask-owner: could not hand the issue to the owner", { issueId: issue.id, error: message(error) });
    }
  }
  const ref = issue.identifier ?? issue.id;
  return {
    askId: ask.id,
    issueId: issue.id,
    identifier: issue.identifier ?? null,
    href: prefix ? `/${prefix}/issues/${ref}` : `/issues/${ref}`,
    status: existing ? "updated" : "asked",
    handedToOwner,
    next: handedToOwner
      ? `${ref} is with the owner now (in review) and shows first in the Cockpit's Waiting on you and the daily brief. You are woken on ${ref} with the answer. Meanwhile do the parts that do not depend on it; do not ask again unless the question changes.`
      : `The question is posted and shows in the Cockpit's Waiting on you, but ${ref} could not be handed to the owner. Leave it as it is; you are woken on ${ref} with the answer.`,
  };
}

// ---------------------------------------------------------------------------
// The answer, and closing
// ---------------------------------------------------------------------------

/** Hand the issue back with the answer and wake the agent. `effect` is what the answer's effect did, told to the agent in the wake reason. */
async function handBack(env: Env, ask: AskRow, answer: string, effect: string | null = null): Promise<{ agentId: string | null; woke: boolean }> {
  const companyId = ask.companyId;
  let target = (await usableAgent(env, companyId, ask.returnAgentId)) ?? (await usableAgent(env, companyId, ask.agentId));
  if (!target) {
    const route = routeFromRoles(await currentRoles(env, companyId), ["operator"]);
    target = route.assigneeAgentId ? await usableAgent(env, companyId, route.assigneeAgentId) : null;
  }
  const ref = ask.issueIdentifier ?? ask.issueId;
  if (!target) {
    await env.ctx.issues.createComment(ask.issueId, "Answer recorded, but no agent can take this issue back (the agent that asked is gone and there is no Operator). It stays with you: hand it to an agent in Setup → Team or here.", companyId).catch(() => undefined);
    return { agentId: null, woke: false };
  }
  try {
    await env.ctx.issues.update(ask.issueId, { assigneeAgentId: target.id, assigneeUserId: null, status: "todo" }, companyId);
  } catch (error) {
    env.ctx.logger.info("ask-owner: could not hand the issue back", { issueId: ask.issueId, error: message(error) });
    return { agentId: null, woke: false };
  }
  await env.ctx.issues.createComment(ask.issueId, `Answer recorded. Handed back to **${target.name}**, who carries on.`, companyId).catch(() => undefined);
  let woke = false;
  try {
    await env.ctx.issues.requestWakeup(ask.issueId, companyId, { reason: wakeReason({ identifier: ask.issueIdentifier, answer, options: ask.options, effect }), idempotencyKey: `ask:${ask.id}:answered` });
    woke = true;
  } catch (error) {
    env.ctx.logger.info("ask-owner: wake skipped", { issueId: ask.issueId, error: message(error) });
  }
  await recordActivity(env.ctx, companyId, {
    key: `ask:${ask.id}:answered`,
    kind: "ask_answered",
    at: env.now().toISOString(),
    text: `The owner answered ${target.name}'s question on ${ref}`,
    href: `/issues/${ref}`,
    agentId: target.id,
  }).catch(() => false);
  await env.ctx.db.execute(`UPDATE ${TABLE} SET handed_back_at = $3 WHERE company_id = $1 AND id = $2`, [companyId, ask.id, env.now().toISOString()]).catch(() => undefined);
  return { agentId: target.id, woke };
}

/**
 * Records a person's reply as the answer and hands the issue back. When the
 * person also closed the issue (a reply and a close in one step), the answer
 * is kept and the issue stays closed.
 */
async function answerAsk(env: Env, ask: AskRow, comment: { id: string; body: string; userId: string | null }): Promise<boolean> {
  const answer = comment.body.trim().slice(0, ASK_LIMITS.answerChars);
  if (!answer) return false;
  const issue = await env.ctx.issues.get(ask.issueId, ask.companyId).catch(() => null);
  const closedIssue = !issue || CLOSED.has(String(issue.status));
  const status = !issue || issue.status === "cancelled" ? "cancelled" : closedIssue ? "resolved" : "answered";
  const answeredAt = env.now().toISOString();
  const closed = await closeAsk(env, ask, { status, answer, answerCommentId: comment.id, answeredByUserId: comment.userId }, answeredAt);
  if (!closed) return false;
  // An ask with an effect runs it for a person's yes (never for an agent's own comment: only a reply by a person gets here), and the agent is
  // woken when the result is in, not before: otherwise it finds the grant still missing and asks again.
  if (ask.effect && comment.userId && status !== "cancelled") {
    await startEffect(env, { ...ask, status, answer, answeredByUserId: comment.userId, closedAt: answeredAt }, answeredAt);
    return true;
  }
  if (!closedIssue) await handBack(env, ask, answer);
  return true;
}

// ---------------------------------------------------------------------------
// Effects: an answer that does something (RC5)
// ---------------------------------------------------------------------------

/** An announced effect with no result after this long is reported as failed (the plugin that handles it is missing, off or has no saved settings). */
export const EFFECT_TIMEOUT_MS = 3 * 3_600_000;
/** Re-announced at most this often (events are at-most-once). */
export const EFFECT_REANNOUNCE_MS = 5 * 60_000;

function answeredFor(ask: AskRow, key: string, answeredAt: string): AskAnswered | null {
  if (!ask.effect || !ask.answeredByUserId || !ask.answer) return null;
  return {
    key,
    askId: ask.id,
    issueId: ask.issueId,
    issueIdentifier: ask.issueIdentifier,
    kind: ask.kind,
    effect: { key: ask.effect.key, ...(ask.effect.params ? { params: ask.effect.params } : {}) },
    question: ask.question,
    options: ask.options,
    answer: ask.answer,
    answeredByUserId: ask.answeredByUserId,
    answeredAt,
    returnAgentId: ask.returnAgentId,
  };
}

/** The effect starts: a local one runs now, another plugin's is announced and awaited. */
async function startEffect(env: Env, ask: AskRow, answeredAt: string): Promise<void> {
  const key = askAnsweredKey(ask.id, answeredAt);
  const answered = answeredFor(ask, key, answeredAt);
  if (!answered) return;
  await env.ctx.db.execute(
    `UPDATE ${TABLE} SET effect_key = $3, effect_status = 'pending', effect_announced_at = $4, effect_announced_count = 1 WHERE company_id = $1 AND id = $2`,
    [ask.companyId, ask.id, key, env.now().toISOString()],
  );
  const pending: AskRow = { ...ask, effectKey: key, effectStatus: "pending" };
  if (askEffectKeys().includes(answered.effect.key)) {
    const result = await runAskEffect(env.ctx, ask.companyId, answered, env.now());
    if (result) await settleEffect(env, pending, result);
    return;
  }
  try {
    await emitAskAnswered(env.ctx, ask.companyId, answered);
  } catch (error) {
    env.ctx.logger.info("ask-owner: the answered ask was not announced; it is re-sent hourly", { askId: ask.id, error: message(error) });
  }
}

/** The one line the agent is woken with, so it knows whether to carry on or stop asking. */
function effectSummary(result: Pick<AskEffectResult, "status" | "detail">): string {
  return `${result.status.replace(/_/g, " ")}: ${result.detail}`.replace(/\s+/g, " ").slice(0, 280);
}

/**
 * The effect's result is in: record it, say what happened on the issue, and
 * hand the issue back to the agent (woken with the outcome). A question the
 * Cockpit asked itself that was applied closes its own issue: nothing is left
 * for anyone to do. Safe to call twice: only the call that finds it pending acts.
 */
export async function settleEffect(env: Env, ask: AskRow, result: Pick<AskEffectResult, "key" | "askId" | "effectKey" | "plugin" | "status" | "detail" | "verified" | "at">, options: { dbStatus?: string } = {}): Promise<boolean> {
  const now = env.now().toISOString();
  const update = await env.ctx.db.execute(
    `UPDATE ${TABLE} SET effect_status = $3, effect_detail = $4, effect_result_at = $5 WHERE company_id = $1 AND id = $2 AND effect_status = 'pending'`,
    [ask.companyId, ask.id, options.dbStatus ?? result.status, result.detail.slice(0, 400), now],
  );
  if ((update.rowCount ?? 0) === 0) return false;
  const full: AskEffectResult = { key: result.key, askId: result.askId, effectKey: result.effectKey, plugin: result.plugin, status: result.status, detail: result.detail, verified: result.verified, at: result.at };
  await env.ctx.issues.createComment(ask.issueId, askEffectComment(full), ask.companyId).catch((error) => env.ctx.logger.info("ask-owner: the effect comment was not posted", { askId: ask.id, error: message(error) }));
  await recordActivity(env.ctx, ask.companyId, {
    key: `ask:${ask.id}:effect:${result.key}`,
    kind: "ask_effect",
    at: now,
    text: `${ask.effect?.key ?? "An answer"}: ${result.status.replace(/_/g, " ")}${result.status === "applied" || result.status === "already_applied" ? "" : ` (${result.detail.slice(0, 120)})`}`,
    href: `/issues/${ask.issueIdentifier ?? ask.issueId}`,
    agentId: ask.returnAgentId,
  }).catch(() => false);
  const issue = await env.ctx.issues.get(ask.issueId, ask.companyId).catch(() => null);
  if (!issue || CLOSED.has(String(issue.status))) return true;
  if (ask.source === "cockpit" && (result.status === "applied" || result.status === "already_applied")) {
    await env.ctx.issues.update(ask.issueId, { status: "done" }, ask.companyId).catch((error) => env.ctx.logger.info("ask-owner: the finished question was not closed", { askId: ask.id, error: message(error) }));
    return true;
  }
  await handBack(env, ask, ask.answer ?? "", effectSummary(result));
  return true;
}

/** `ask.effect.result` from a plugin: settles the ask it answers (a stale or repeated result is ignored). */
export async function onEffectResult(env: Env, companyId: string, result: AskEffectResult): Promise<"settled" | "ignored"> {
  const ask = await getAsk(env, companyId, result.askId);
  if (!ask || ask.effectStatus !== "pending" || ask.effectKey !== result.key) return "ignored";
  return (await settleEffect(env, ask, result)) ? "settled" : "ignored";
}

/**
 * Hourly, for one company: re-announces effects still waiting for a result
 * (events are at-most-once), reruns a local one that was lost with a restart,
 * and ends an effect nobody answered after `EFFECT_TIMEOUT_MS` with a failure
 * the owner can see.
 */
export async function reannounceEffects(env: Env, companyId: string): Promise<{ resent: number; timedOut: number }> {
  const out = { resent: 0, timedOut: 0 };
  const rows = await env.ctx.db.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM ${TABLE} WHERE company_id = $1 AND effect_status = 'pending' AND status <> 'open' ORDER BY closed_at LIMIT 50`, [companyId]);
  const nowMs = env.now().getTime();
  for (const raw of rows) {
    const ask = rowFrom(raw);
    const key = ask.effectKey;
    if (!key || !ask.effect) continue;
    const since = Date.parse(ask.effectAnnouncedAt ?? ask.closedAt ?? "");
    const answeredAt = ask.closedAt ?? env.now().toISOString();
    const answeredMs = Date.parse(ask.closedAt ?? ask.effectAnnouncedAt ?? "");
    if (Number.isFinite(answeredMs) && nowMs - answeredMs >= EFFECT_TIMEOUT_MS) {
      const at = env.now().toISOString();
      const settled = await settleEffect(env, ask, { key, askId: ask.id, effectKey: ask.effect.key, plugin: "cockpit", status: "failed", detail: `Nothing answered in ${Math.round(EFFECT_TIMEOUT_MS / 3_600_000)} hours: the plugin that handles ${ask.effect.key} is missing, switched off, or its settings are not saved for this company. Nothing was changed.`, verified: false, at }, { dbStatus: "timeout" });
      if (settled) out.timedOut += 1;
      continue;
    }
    const answered = answeredFor(ask, key, answeredAt);
    if (!answered) continue;
    if (Number.isFinite(since) && nowMs - since < EFFECT_REANNOUNCE_MS) continue;
    if (askEffectKeys().includes(answered.effect.key)) {
      const result = await runAskEffect(env.ctx, companyId, answered, env.now());
      if (result) await settleEffect(env, ask, result);
      continue;
    }
    try {
      await emitAskAnswered(env.ctx, companyId, answered);
      await env.ctx.db.execute(`UPDATE ${TABLE} SET effect_announced_at = $3, effect_announced_count = effect_announced_count + 1 WHERE company_id = $1 AND id = $2`, [companyId, ask.id, env.now().toISOString()]);
      out.resent += 1;
    } catch (error) {
      env.ctx.logger.info("ask-owner: re-announcing an answered ask failed", { askId: ask.id, error: message(error) });
    }
  }
  return out;
}

/** Answers whose effect failed or was refused: nothing else tells the owner, so each is a Needs-you item until its issue is closed. */
export async function effectWaitingItems(env: Env, companyId: string): Promise<Array<{ key: string; title: string; why: string; href: string; issueId: string; kind: "judgement"; since: string | null }>> {
  const since = new Date(env.now().getTime() - 14 * 86_400_000).toISOString();
  const rows = await env.ctx.db.query<Record<string, unknown>>(
    `SELECT a.id, a.question, a.issue_id, a.issue_identifier, a.effect_key, a.effect, a.effect_status, a.effect_detail, a.effect_result_at
       FROM ${TABLE} a JOIN public.issues i ON i.id::text = a.issue_id AND i.company_id::text = a.company_id
      WHERE a.company_id = $1 AND a.effect_status IN ('failed', 'refused', 'timeout') AND a.effect_result_at >= $2::timestamptz AND i.status NOT IN ('done', 'cancelled')
      ORDER BY a.effect_result_at LIMIT 10`,
    [companyId, since],
  );
  return rows.map((r) => {
    const effect = json<AskEffect | null>(r.effect, null);
    const status = String(r.effect_status);
    return {
      key: `ask-effect:${String(r.id)}`,
      title: `The answer to "${String(r.question ?? "").slice(0, 90)}" could not be applied`,
      why: `${effect ? `${effect.key}: ` : ""}${status === "refused" ? "was refused by a safety check" : status === "timeout" ? "got no answer from the plugin that handles it" : "failed"}. ${String(r.effect_detail ?? "")} A person has to look at why; the agent was told not to ask again.`.replace(/\s+/g, " ").trim(),
      href: `/issues/${String(r.issue_identifier ?? r.issue_id)}`,
      issueId: String(r.issue_id),
      kind: "judgement" as const,
      since: iso(r.effect_result_at) || null,
    };
  });
}

/** Host `issue.comment.created`: a person's comment on an issue with an open ask answers it. */
export async function onAskComment(env: Env, event: Pick<PluginEvent, "companyId" | "entityId" | "entityType" | "actorType" | "actorId" | "payload">): Promise<"answered" | "ignored"> {
  if (event.actorType !== "user") return "ignored";
  const companyId = event.companyId;
  const issueId = event.entityType === "issue" ? event.entityId ?? null : null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const commentId = typeof payload.commentId === "string" ? payload.commentId : null;
  if (!companyId || !issueId || !commentId) return "ignored";
  const ask = await openAskForIssue(env, companyId, issueId);
  if (!ask) return "ignored";
  const comments = await env.ctx.issues.listComments(issueId, companyId);
  const comment = comments.find((c) => c.id === commentId);
  if (!comment || comment.deletedAt || typeof comment.body !== "string" || !comment.authorUserId) return "ignored";
  return (await answerAsk(env, ask, { id: comment.id, body: comment.body, userId: comment.authorUserId })) ? "answered" : "ignored";
}

/** Closes the ask when its issue closed or went back to an agent without a reply. Returns what happened. */
async function settleByIssue(env: Env, ask: AskRow): Promise<"resolved" | "cancelled" | "open"> {
  const issue = await env.ctx.issues.get(ask.issueId, ask.companyId).catch(() => null);
  const now = env.now().toISOString();
  if (!issue || issue.status === "cancelled") {
    await closeAsk(env, ask, { status: "cancelled" }, now);
    return "cancelled";
  }
  if (issue.status === "done") {
    await closeAsk(env, ask, { status: "resolved" }, now);
    return "resolved";
  }
  // Someone handed it to an agent without replying: nothing waits on the owner any more.
  if (issue.assigneeAgentId && !issue.assigneeUserId) {
    await closeAsk(env, ask, { status: "resolved" }, now);
    return "resolved";
  }
  return "open";
}

/** Host `issue.updated`: an open ask follows its issue. */
export async function onAskIssueUpdated(env: Env, event: Pick<PluginEvent, "companyId" | "entityId" | "entityType">): Promise<"resolved" | "cancelled" | "open" | "ignored"> {
  const issueId = event.entityType === "issue" ? event.entityId ?? null : null;
  if (!event.companyId || !issueId) return "ignored";
  const ask = await openAskForIssue(env, event.companyId, issueId);
  if (!ask) return "ignored";
  return settleByIssue(env, ask);
}

/**
 * Hourly (events are at-most-once): closes asks whose issue closed or moved
 * on, and takes a person's reply that was missed as the answer.
 */
export async function reconcileAsks(env: Env, companyId: string): Promise<{ answered: number; closed: number; open: number }> {
  const out = { answered: 0, closed: 0, open: 0 };
  for (const ask of await listOpenAsks(env, companyId, 200)) {
    try {
      const state = await settleByIssue(env, ask);
      if (state !== "open") {
        out.closed += 1;
        continue;
      }
      const comments = await env.ctx.issues.listComments(ask.issueId, companyId);
      const at = comments.findIndex((c) => c.id === ask.commentId);
      const since = Date.parse(ask.updatedAt);
      const reply = comments.find((c, index) => {
        if (!c.authorUserId || c.deletedAt || typeof c.body !== "string" || !c.body.trim()) return false;
        if (at >= 0) return index > at;
        const created = Date.parse(String(c.createdAt ?? ""));
        return Number.isFinite(created) && created > since;
      });
      if (reply && (await answerAsk(env, ask, { id: reply.id, body: reply.body, userId: reply.authorUserId }))) out.answered += 1;
      else out.open += 1;
    } catch (error) {
      env.ctx.logger.info("Ask check failed", { askId: ask.id, error: message(error) });
      out.open += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Views (page, brief, health)
// ---------------------------------------------------------------------------

/** Open asks with the asking agent's and the client's names, oldest first. */
export async function openAskViews(env: Env, companyId: string): Promise<AskView[]> {
  const asks = await listOpenAsks(env, companyId);
  if (asks.length === 0) return [];
  const agents = new Map<string, string>();
  for (const id of new Set(asks.map((a) => a.agentId).filter((id): id is string => !!id))) {
    const name = await agentName(env, companyId, id);
    if (name) agents.set(id, name);
  }
  const clients = new Map<string, string | null>();
  for (const ref of new Set(asks.map((a) => a.clientRef).filter((r): r is string => !!r))) {
    const client = await crmClient(env.ctx, companyId, ref).catch(() => null);
    clients.set(ref, client?.name ?? null);
  }
  return asks.map((ask) => ({
    id: ask.id,
    issueId: ask.issueId,
    identifier: ask.issueIdentifier,
    issueTitle: ask.issueTitle,
    kind: ask.kind,
    question: ask.question,
    options: ask.options,
    why: ask.why,
    askedBy: ask.agentId ? agents.get(ask.agentId) ?? null : null,
    askedByAgentId: ask.agentId,
    askedAt: ask.askedAt,
    updatedAt: ask.updatedAt,
    dueBy: ask.dueBy,
    clientRef: ask.clientRef,
    clientName: ask.clientRef ? clients.get(ask.clientRef) ?? null : null,
  }));
}
