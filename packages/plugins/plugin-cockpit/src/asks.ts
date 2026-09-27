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
import { recordActivity } from "./activity.js";
import { askComment, AskError, ASK_LIMITS, parseAskInput, wakeReason, type AskInput, type AskKind, type AskView } from "./ask-model.js";
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
}

const COLUMNS =
  "id, company_id, issue_id, issue_identifier, issue_title, agent_id, return_agent_id, run_id, question, options, why, kind, links, steps, client_ref, due_by, owner_user_id, status, comment_id, answer, answer_comment_id, answered_by_user_id, asked_count, asked_at, updated_at, closed_at";

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

async function insertAsk(env: Env, row: AskRow): Promise<void> {
  await env.ctx.db.execute(
    `INSERT INTO ${TABLE} (id, company_id, issue_id, issue_identifier, issue_title, agent_id, return_agent_id, run_id, question, options, why, kind, links, steps, client_ref, due_by, owner_user_id, status, asked_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18, $19, $20)`,
    [
      row.id, row.companyId, row.issueId, row.issueIdentifier, row.issueTitle, row.agentId, row.returnAgentId, row.runId, row.question, JSON.stringify(row.options), row.why, row.kind,
      JSON.stringify(row.links), JSON.stringify(row.steps), row.clientRef, row.dueBy, row.ownerUserId, "open", row.askedAt, row.updatedAt,
    ],
  );
}

/** Asking again on the same issue: the new question replaces the old one; the age counts from the first ask. */
async function updateOpenAsk(env: Env, ask: AskRow, input: AskInput, agentId: string, runId: string | null, ownerUserId: string, now: string): Promise<void> {
  await env.ctx.db.execute(
    `UPDATE ${TABLE} SET question = $3, options = $4::jsonb, why = $5, kind = $6, links = $7::jsonb, steps = $8::jsonb, client_ref = $9, due_by = $10, owner_user_id = $11, agent_id = $12, run_id = $13, asked_count = $14, updated_at = $15
      WHERE company_id = $1 AND id = $2 AND status = 'open'`,
    [ask.companyId, ask.id, input.question, JSON.stringify(input.options), input.why, input.kind, JSON.stringify(input.links), JSON.stringify(input.steps), input.client ?? ask.clientRef, input.dueBy, ownerUserId, agentId, runId, ask.askedCount + 1, now],
  );
}

async function setCommentId(env: Env, ask: Pick<AskRow, "companyId" | "id">, commentId: string | null): Promise<void> {
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

function newId(): string {
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
      id: newId(),
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

  const [prefix, returnName, label] = await Promise.all([
    prefixOf(env, companyId),
    agentName(env, companyId, ask.returnAgentId ?? agentId),
    clientLabel(env, companyId, ask.clientRef),
  ]);
  const body = askComment({ ask: input, agentName: returnName ?? "the agent", clientLabel: label, prefix, again: !!existing });
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

/** Hand the issue back with the answer and wake the agent. */
async function handBack(env: Env, ask: AskRow, answer: string): Promise<{ agentId: string | null; woke: boolean }> {
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
    await env.ctx.issues.requestWakeup(ask.issueId, companyId, { reason: wakeReason({ identifier: ask.issueIdentifier, answer, options: ask.options }), idempotencyKey: `ask:${ask.id}:answered` });
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
  const closed = await closeAsk(env, ask, { status, answer, answerCommentId: comment.id, answeredByUserId: comment.userId }, env.now().toISOString());
  if (!closed) return false;
  if (!closedIssue) await handBack(env, ask, answer);
  return true;
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
