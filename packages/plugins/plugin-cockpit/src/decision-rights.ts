/**
 * Decision rights, worker side: reads the company's seats and hands a question
 * that is not a hard stop to the seat that decides it, at the moment an agent
 * raises it with `ask-owner`. The owner never sees it.
 *
 * Routing opens one Decision issue for the seat (a child of the asking issue),
 * makes it block the asking issue and wakes the seat. When the seat closes it,
 * the host wakes the asker (`issue_blockers_resolved`). Asking again on the
 * same issue updates the open Decision issue instead of opening a second one.
 */
import { createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import { prefixed, type AskInput } from "./ask-model.js";
import { ORIGIN } from "./constants.js";
import { DECISION_CLASS_LABEL, HARD_STOPS, NO_DECISION_RIGHTS, parseDecisionRights, type AskRoute, type DecisionClass, type DecisionRights } from "./decision-rights-model.js";
import { message, type Env } from "./env.js";
import { recordRepair } from "./repairs.js";

const GONE = new Set(["terminated", "archived", "deleted"]);
const CLOSED = new Set(["done", "cancelled"]);

/** Repairs rows for routed questions (`kind`), read by the digest for its "went to the deciding seat" count. */
export const ROUTED_REPAIR_KIND = "ask_routed";

export async function readDecisionRights(env: Env, companyId: string): Promise<DecisionRights> {
  try {
    return parseDecisionRights(await env.ctx.config.get(companyId));
  } catch (error) {
    env.ctx.logger.info("Decision rights: settings could not be read, so questions go to the owner", { companyId, error: message(error) });
    return NO_DECISION_RIGHTS;
  }
}

export function decisionOriginId(issueId: string): string {
  return `cockpit:decision:${issueId}`;
}

export interface DecisionIssueText {
  title: string;
  description: string;
}

/** What the deciding seat reads. Pure. */
export function decisionIssueText(input: {
  ask: Pick<AskInput, "question" | "options" | "why" | "links" | "steps" | "dueBy">;
  decisionClass: DecisionClass;
  askerName: string;
  issueRef: string;
  issueTitle: string | null;
  issueHref: string;
  prefix: string | null;
  passedUp: boolean;
}): DecisionIssueText {
  const { ask } = input;
  const label = DECISION_CLASS_LABEL[input.decisionClass];
  const question = ask.question.length > 110 ? `${ask.question.slice(0, 109)}…` : ask.question;
  const lines = [
    `**${input.askerName} needs a decision on [${input.issueRef}](${input.issueHref})**${input.issueTitle ? `: ${input.issueTitle}` : ""}`,
    "",
    input.passedUp
      ? `Class: ${label}. The seat that decides this class could not decide it and passed it to you.`
      : `Class: ${label}. You decide this class; it does not go to the owner.`,
    "",
    ask.question,
    "",
  ];
  if (ask.options.length) {
    lines.push("**Options** (recommended first)");
    ask.options.forEach((option, index) => lines.push(`${index + 1}. ${index === 0 ? `**${option}** (recommended)` : option}`));
    lines.push("");
  }
  lines.push(`**Why it matters:** ${ask.why}`, "");
  if (ask.steps.length) {
    lines.push("**What it takes**");
    ask.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
    lines.push("");
  }
  if (ask.links.length) lines.push(`**Links:** ${ask.links.map((l) => `[${l.label.replace(/[[\]]/g, "")}](${prefixed(l.href, input.prefix)})`).join(" · ")}`, "");
  if (ask.dueBy) lines.push(`Needed by ${ask.dueBy}.`, "");
  lines.push(
    "**How to decide**",
    `1. Decide today. Comment on ${input.issueRef} with the first line \`DECISION (${label}): yes|no, <one reason>\`. A no names the one thing that would change it.`,
    `2. Set this issue to done. That wakes ${input.askerName} on ${input.issueRef}.`,
    `3. Only if it is truly a hard stop (${Object.values(HARD_STOPS).map((h) => h.label).join("; ")}), do not decide: ask the owner on this issue with ask-owner and name the hard stop.`,
  );
  return { title: `Decision (${label}): ${question}`, description: lines.join("\n") };
}

export interface RoutedAsk {
  decisionIssueId: string;
  decisionIdentifier: string | null;
  seatAgentId: string;
  seatName: string;
  decisionClass: DecisionClass;
  created: boolean;
  blocked: boolean;
}

/**
 * Hands the question to the seat. Returns null when the seat cannot take it
 * (the agent is gone, or the issue could not be opened): the caller then asks
 * the owner as before, so a broken seat never swallows a question.
 */
export async function routeAskToSeat(
  env: Env,
  input: {
    companyId: string;
    issue: { id: string; identifier?: string | null; title?: string | null; priority?: string | null; projectId?: string | null };
    ask: AskInput;
    askerAgentId: string;
    askerName: string | null;
    route: Extract<AskRoute, { to: "seat" }>;
    prefix: string | null;
  },
): Promise<RoutedAsk | null> {
  const { companyId, issue, ask, route } = input;
  const { ctx } = env;
  const seat = await ctx.agents.get(route.seatAgentId, companyId).catch(() => null);
  if (!seat || GONE.has(String(seat.status))) {
    ctx.logger.info("Decision rights: the deciding seat is not usable, so the question goes to the owner", { companyId, issueId: issue.id, seatAgentId: route.seatAgentId, decisionClass: route.decisionClass });
    return null;
  }
  const seatName = String(seat.name ?? "the deciding seat");
  const askerName = input.askerName ?? "An agent";
  const ref = issue.identifier ?? issue.id;
  const issueHref = input.prefix ? `/${input.prefix}/issues/${ref}` : `/issues/${ref}`;
  const text = decisionIssueText({ ask, decisionClass: route.decisionClass, askerName, issueRef: ref, issueTitle: issue.title ?? null, issueHref, prefix: input.prefix, passedUp: route.passedUp });
  const originId = decisionOriginId(issue.id);

  let decisionId: string | null = null;
  let decisionIdentifier: string | null = null;
  let created = false;
  try {
    const found = (await ctx.issues.list({ companyId, originKind: ORIGIN.decision as `plugin:${string}`, originId, limit: 10 })) as unknown as Array<{ id: string; identifier?: string | null; status: string; assigneeAgentId?: string | null }>;
    const open = found.find((i) => !CLOSED.has(String(i.status)) && i.assigneeAgentId === route.seatAgentId);
    if (open) {
      decisionId = open.id;
      decisionIdentifier = open.identifier ?? null;
      await ctx.issues.createComment(open.id, `**The question changed.**\n\n${text.description}`, companyId, { authorAgentId: input.askerAgentId });
      await ctx.issues.requestWakeup(open.id, companyId, { reason: `${askerName} changed the question on ${ref}.`, idempotencyKey: `decision:${open.id}:${env.now().toISOString()}` }).catch(() => undefined);
    } else {
      const made = await createWorkIssue(ctx, {
        companyId,
        title: text.title,
        description: text.description,
        assigneeAgentId: route.seatAgentId,
        parentId: issue.id,
        ...(issue.projectId ? { projectId: issue.projectId } : {}),
        priority: (issue.priority ?? "medium") as "critical" | "high" | "medium" | "low",
        originKind: ORIGIN.decision as `plugin:${string}`,
        originId,
        wake: true,
        wakeReason: `Decision needed (${DECISION_CLASS_LABEL[route.decisionClass]}) on ${ref}.`,
      });
      decisionId = made.id;
      created = true;
      decisionIdentifier = (await ctx.issues.get(made.id, companyId).catch(() => null))?.identifier ?? null;
    }
  } catch (error) {
    ctx.logger.info("Decision rights: the Decision issue could not be opened, so the question goes to the owner", { companyId, issueId: issue.id, error: message(error) });
    return null;
  }

  // The Decision issue blocks the asking issue: closing it wakes the asker.
  let blocked = false;
  try {
    const relations = await ctx.issues.relations.get(issue.id, companyId);
    const blockedBy = new Set((relations.blockedBy ?? []).map((b) => b.id));
    blockedBy.add(decisionId);
    await ctx.issues.update(issue.id, { status: "blocked", blockedByIssueIds: [...blockedBy] }, companyId);
    blocked = true;
  } catch (error) {
    ctx.logger.info("Decision rights: the asking issue was not marked blocked", { companyId, issueId: issue.id, error: message(error) });
  }

  const decisionRef = decisionIdentifier ?? decisionId;
  const decisionHref = input.prefix ? `/${input.prefix}/issues/${decisionRef}` : `/issues/${decisionRef}`;
  await ctx.issues
    .createComment(
      issue.id,
      `**Decision needed: with ${seatName}** ([${decisionRef}](${decisionHref})). Class: ${DECISION_CLASS_LABEL[route.decisionClass]}. This is not a hard stop, so it does not go to the owner.\n\n${ask.question}`,
      companyId,
      { authorAgentId: input.askerAgentId },
    )
    .catch((error) => ctx.logger.info("Decision rights: the routing comment was not posted", { issueId: issue.id, error: message(error) }));
  await recordRepair(ctx, companyId, {
    kind: ROUTED_REPAIR_KIND,
    targetKind: "issue",
    targetId: issue.id,
    action: "route_to_seat",
    outcome: created ? "routed" : "updated",
    detail: `${route.decisionClass} -> ${seatName} (${decisionRef})`,
    actor: `agent:${input.askerAgentId}`,
  }).catch((error) => ctx.logger.info("Decision rights: the routing was not recorded", { issueId: issue.id, error: message(error) }));

  return { decisionIssueId: decisionId, decisionIdentifier, seatAgentId: route.seatAgentId, seatName, decisionClass: route.decisionClass, created, blocked };
}
