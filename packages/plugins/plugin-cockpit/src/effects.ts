/**
 * The ask effects the Cockpit itself handles, and the questions the Cockpit
 * asks the owner on its own account (RC5: an answer must be an effect).
 *
 * Effects (kit `registerAskEffect`, run with `runAskEffect` on the Cockpit's
 * own questions: no event is needed for the plugin that asks and answers):
 * - `cockpit.grant-memory-tools`  the kit's memory-only grant for agents that
 *   cannot call the memory tools. An agent MAY ask for it with `ask-owner`:
 *   the handler checks every agent id is an active agent of this company and
 *   writes only the fixed grant.
 * - `cockpit.activate-goals`      adopt the proposed goals the question lists.
 *   INTERNAL: an agent's `ask-owner` is refused if it names it (nor the
 *   reserved `cockpit.attest`), so a leading question cannot make a yes adopt
 *   or confirm something the owner never read. Owner confirmations (sign-up
 *   closed, backup key custody) are recorded by Setup's Confirm buttons only.
 *
 * Another plugin's effect (`mailbox.delegate`) is announced to that plugin by
 * `ask.answered` and its result comes back as `ask.effect.result` (asks.ts).
 */
import { agentsWithoutPluginTools, askCardProblems, checkEffectParams, memoryGrantAsk, MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect, registerAskEffect, type AskEffectHandler } from "@partnersinbiz/pib-plugin-kit";
import { askComment, type AskEffect } from "./ask-model.js";
import { insertAsk, newAskId, setCommentId, type AskRow } from "./asks.js";
import { assignableUser, ORIGIN, ORIGIN_ID } from "./constants.js";
import { getRoles } from "./db.js";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { ACTIVATE_GOALS_EFFECT, goalsAskCard } from "./goals-model.js";
import { activateGoals, getGoal, listGoals } from "./goals.js";
import { NAMESPACE } from "./namespace.js";
import { currentRoles, routeFromRoles } from "./roles.js";

const ASKS = `${NAMESPACE}.asks`;

const GOAL_ID = /^goal[a-f0-9]{12}$/;

function goalIds(value: unknown): string[] {
  return typeof value === "string" ? [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))] : [];
}

/** Adopts the proposed goals the question named, for the person who said yes. */
export function activateGoalsEffect(env: Env): AskEffectHandler {
  return {
    async validate(input) {
      const checked = checkEffectParams(input.ask.effect.params, { goalIds: { required: true, type: "string", maxLength: 400 } });
      if (!checked.ok) return checked.problems.join("; ");
      const ids = goalIds(input.ask.effect.params?.goalIds);
      if (ids.length === 0 || ids.length > 12) return "name between 1 and 12 goals";
      if (ids.some((id) => !GOAL_ID.test(id))) return "a goal id is not valid";
      for (const id of ids) {
        const goal = await getGoal(env.ctx, input.companyId, id);
        if (!goal) return `goal ${id} does not exist in this company`;
        if (goal.status !== "proposed" && goal.status !== "active") return `goal ${id} is not waiting for confirmation`;
      }
      return null;
    },
    async apply(input) {
      const ids = goalIds(input.ask.effect.params?.goalIds);
      const done = await activateGoals(env, input.companyId, ids, input.ask.answeredByUserId);
      return { detail: done.length === 0 ? "The goals were already active." : `Adopted ${done.length} ${done.length === 1 ? "goal" : "goals"}: ${done.map((g) => g.title).join("; ")}.` };
    },
    async verify(input) {
      for (const id of goalIds(input.ask.effect.params?.goalIds)) {
        const goal = await getGoal(env.ctx, input.companyId, id);
        if (!goal || (goal.status !== "active" && goal.status !== "achieved")) return { ok: false, detail: `goal ${id} is not active` };
      }
      return true;
    },
  };
}

/** Registers the effects this plugin handles (call once in setup; the registry is per worker). */
export function registerCockpitEffects(env: Env): void {
  registerAskEffect(MEMORY_GRANT_EFFECT_KEY, memoryGrantEffect);
  registerAskEffect(ACTIVATE_GOALS_EFFECT, activateGoalsEffect(env));
}

// ---------------------------------------------------------------------------
// Questions the Cockpit asks the owner itself
// ---------------------------------------------------------------------------

export interface CockpitCard {
  kind: "grant" | "decision";
  question: string;
  why: string;
  options: string[];
  links: Array<{ label: string; href: string }>;
  steps: string[];
  effect: AskEffect;
}

export type CockpitAskResult = { action: "opened"; askId: string; issueId: string } | { action: "exists" | "skipped"; reason: string };

/**
 * Opens an issue for the owner (in review) carrying one question with an
 * effect. The owner's reply on it is read like any ask's (asks.ts): a yes runs
 * the effect, checks it, comments the result, and closes the issue when it
 * worked or hands it to the Operator when it did not.
 */
export async function openCockpitAsk(env: Env, companyId: string, spec: { originKey: string; title: string; card: CockpitCard }): Promise<CockpitAskResult> {
  const roles = await getRoles(env.ctx, companyId);
  const owner = assignableUser(roles?.ownerUserId ?? null);
  if (!owner) return { action: "skipped", reason: "No owner is set, so there is nobody to ask." };
  const problems = askCardProblems({ kind: spec.card.kind, links: spec.card.links, steps: spec.card.steps, effect: spec.card.effect });
  if (problems.length > 0) return { action: "skipped", reason: problems.join(" ") };
  const open = await env.ctx.db.query<Record<string, unknown>>(`SELECT id, issue_id FROM ${ASKS} WHERE company_id = $1 AND source = 'cockpit' AND status = 'open' AND effect ->> 'key' = $2 LIMIT 1`, [companyId, spec.card.effect.key]);
  if (open[0]) return { action: "exists", reason: "That question is already open." };
  const route = routeFromRoles(await currentRoles(env, companyId), ["operator"]);
  const company = await env.ctx.companies.get(companyId).catch(() => null);
  const prefix = company?.issuePrefix ?? null;
  const now = env.now().toISOString();
  const operator = route.assigneeAgentId ? await env.ctx.agents.get(route.assigneeAgentId, companyId).catch(() => null) : null;
  const body = askComment({ ask: { ...spec.card, dueBy: null }, agentName: operator ? String(operator.name ?? "the Operator") : "the Operator", from: "the Cockpit", clientLabel: null, prefix });
  const issue = await env.ctx.issues.create({
    companyId,
    title: spec.title,
    description: `${spec.card.question}\n\n${spec.card.why}\n\nRaised by the Cockpit${operator ? `; your answer goes back to ${String(operator.name ?? "the Operator")}` : ""}. Reply with your answer in a comment on this issue.`,
    status: "in_review",
    priority: "medium",
    assigneeUserId: owner,
    originKind: ORIGIN.ask as `plugin:${string}`,
    originId: `${ORIGIN_ID.ask}${spec.originKey}:${companyId}:${now.slice(0, 10)}`,
  });
  const row: AskRow = {
    id: newAskId(),
    companyId,
    issueId: issue.id,
    issueIdentifier: issue.identifier ?? null,
    issueTitle: spec.title,
    agentId: null,
    returnAgentId: route.assigneeAgentId,
    runId: null,
    question: spec.card.question,
    options: spec.card.options,
    why: spec.card.why,
    kind: spec.card.kind,
    links: spec.card.links,
    steps: spec.card.steps,
    clientRef: null,
    dueBy: null,
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
    source: "cockpit",
    effect: spec.card.effect,
    effectKey: null,
    effectStatus: null,
    effectDetail: null,
    effectAnnouncedAt: null,
    effectAnnouncedCount: 0,
    effectResultAt: null,
    handedBackAt: null,
  };
  await insertAsk(env, row);
  const comment = await env.ctx.issues.createComment(issue.id, body, companyId).catch((error) => {
    env.ctx.logger.info("Cockpit ask: the question comment was not posted", { companyId, error: message(error) });
    return null;
  });
  await setCommentId(env, row, comment ? String((comment as { id?: unknown }).id ?? "") || null : null);
  return { action: "opened", askId: row.id, issueId: issue.id };
}

/** Days before agents already asked about are asked about again (a no is a no for a while). */
export const GRANT_ASK_COOLDOWN_DAYS = 14;

/** The agents a Cockpit memory-access question was put about within the cooldown (answered yes, no, or still open). */
export async function grantAskedRecently(env: Env, companyId: string): Promise<Set<string>> {
  const since = new Date(env.now().getTime() - GRANT_ASK_COOLDOWN_DAYS * 86_400_000).toISOString();
  const recent = await env.ctx.db.query<Record<string, unknown>>(`SELECT effect FROM ${ASKS} WHERE company_id = $1 AND source = 'cockpit' AND effect ->> 'key' = $2 AND asked_at >= $3`, [companyId, MEMORY_GRANT_EFFECT_KEY, since]);
  const asked = new Set<string>();
  for (const r of recent) {
    const effect = typeof r.effect === "string" ? (JSON.parse(r.effect) as AskEffect) : (r.effect as AskEffect | null);
    for (const id of goalIdsLike(effect?.params?.agentIds)) asked.add(id);
  }
  return asked;
}

/** One batched question: let the agents that cannot call the memory tools use them (memory-only, the narrow grant). */
export async function ensureGrantAsk(env: Env, companyId: string): Promise<CockpitAskResult | { action: "none"; reason: string }> {
  const { problems, unreadable } = await agentsWithoutPluginTools(env.ctx, companyId);
  if (unreadable) return { action: "none", reason: "Grants could not be read." };
  if (problems.length === 0) return { action: "none", reason: "Every agent that carries PiB skills can use memory." };
  const asked = await grantAskedRecently(env, companyId);
  const fresh = problems.filter((p) => !asked.has(p.agentId));
  if (fresh.length === 0) return { action: "none", reason: "These agents were asked about recently." };
  const company = await env.ctx.companies.get(companyId).catch(() => null);
  const card = memoryGrantAsk(fresh, { prefix: company?.issuePrefix ?? null });
  return openCockpitAsk(env, companyId, {
    originKey: "grant-memory",
    title: `Let ${fresh.length} ${fresh.length === 1 ? "agent" : "agents"} use company memory`,
    card: { ...card, kind: "grant", why: "Agents that cannot call the memory tools never recall what the company has learned, however much their skill tells them to.", effect: card.effect as AskEffect },
  });
}

function goalIdsLike(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").map((id) => id.trim()).filter(Boolean) : [];
}

/**
 * One batched question: adopt the proposed goals the owner has not been asked
 * about yet. A question lists at most `GOALS_PER_QUESTION` goals and adopts only
 * those, so a goal is asked about again only when no earlier question listed it
 * or it changed after the owner answered; goals left over from a long list get
 * the next question once this one is closed.
 */
export async function ensureGoalsAsk(env: Env, companyId: string): Promise<CockpitAskResult | { action: "none"; reason: string }> {
  const proposed = await listGoals(env.ctx, companyId, ["proposed"]);
  if (proposed.length === 0) return { action: "none", reason: "No goal is waiting for confirmation." };
  const earlier = await env.ctx.db.query<Record<string, unknown>>(`SELECT status, closed_at, effect FROM ${ASKS} WHERE company_id = $1 AND source = 'cockpit' AND effect ->> 'key' = $2 ORDER BY asked_at DESC LIMIT 50`, [companyId, ACTIVATE_GOALS_EFFECT]);
  if (earlier.some((r) => String(r.status) === "open")) return { action: "exists", reason: "The goals question is already open." };
  // When the owner last answered about each goal (the latest closed question that listed it).
  const answered = new Map<string, number>();
  for (const r of earlier) {
    const closedAt = r.closed_at ? Date.parse(String(r.closed_at)) : Number.NaN;
    if (!Number.isFinite(closedAt)) continue;
    const effect = typeof r.effect === "string" ? (JSON.parse(r.effect) as AskEffect) : (r.effect as AskEffect | null);
    for (const id of goalIdsLike(effect?.params?.goalIds)) answered.set(id, Math.max(answered.get(id) ?? 0, closedAt));
  }
  const fresh = proposed.filter((g) => {
    const at = answered.get(g.id);
    return at === undefined || Date.parse(g.updatedAt) > at;
  });
  if (fresh.length === 0) return { action: "none", reason: "The owner already answered about these goals as they stand." };
  const company = await env.ctx.companies.get(companyId).catch(() => null);
  const prefix = company?.issuePrefix ?? null;
  const card = goalsAskCard(fresh, { cockpitHref: prefix ? `/${prefix}/cockpit` : "/cockpit" });
  const listed = goalIdsLike(card.effect.params.goalIds).length;
  return openCockpitAsk(env, companyId, { originKey: "goals", title: `Adopt ${listed === 1 ? "this goal" : `these ${listed} goals`}`, card });
}

/** Hourly, for one company: the questions the Cockpit asks on its own account. Each is one question per kind of thing, never one per agent or goal. */
export async function ensureCockpitAsks(env: Env, companyId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, run] of [["grant", ensureGrantAsk], ["goals", ensureGoalsAsk]] as const) {
    try {
      out[name] = (await run(env, companyId)).action;
    } catch (error) {
      out[name] = "failed";
      env.ctx.logger.info("Cockpit question failed", { companyId, name, error: message(error) });
    }
  }
  return out;
}

/** Closes the Cockpit's own open questions for an effect (the owner did the thing another way): the ask is resolved and its issue closed. */
export async function resolveOpenCockpitAsks(env: Env, companyId: string, effectKey: string, note: string): Promise<number> {
  const rows = await env.ctx.db.query<Record<string, unknown>>(`SELECT id, issue_id FROM ${ASKS} WHERE company_id = $1 AND source = 'cockpit' AND status = 'open' AND effect ->> 'key' = $2`, [companyId, effectKey]);
  const now = env.now().toISOString();
  for (const r of rows) {
    await env.ctx.db.execute(`UPDATE ${ASKS} SET status = 'resolved', closed_at = $3, updated_at = $3 WHERE company_id = $1 AND id = $2 AND status = 'open'`, [companyId, String(r.id), now]);
    await env.ctx.issues.createComment(String(r.issue_id), note, companyId).catch(() => undefined);
    await env.ctx.issues.update(String(r.issue_id), { status: "done" }, companyId).catch(() => undefined);
  }
  return rows.length;
}
