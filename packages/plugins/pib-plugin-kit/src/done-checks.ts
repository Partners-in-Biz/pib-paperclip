/**
 * Done-checks: the loop that keeps an agent on a job until it is really done.
 *
 * A plugin registers one rule per kind of work it hands to agents (matched by
 * the issue's origin id, which the plugin sets when it opens the issue). When
 * an AGENT marks such an issue done, the plugin checks the outcome in its own
 * data. If the work is not finished, the issue is reopened with exactly what
 * is missing and the agent is woken to finish it. People can always close an
 * issue themselves; their close is never checked.
 *
 * To stop a loop, the third failed close hands the issue to the Operator (or
 * the owner when there is no Operator) with the facts.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { routeWork } from "./cockpit.js";
import { wakeIssue } from "./issues.js";

export interface DoneCheckIssue {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  /** `plugin:<key>` or `plugin:<key>:<kind>`: always this plugin's (others are skipped). */
  originKind?: string | null;
  originId: string | null;
  assigneeAgentId: string | null;
  createdAt: string | null;
}

export interface DoneCheckResult {
  done: boolean;
  /** What is still missing, one short line each ("2 draft invoices still have no send request"). */
  missing?: string[];
}

export interface DoneCheckRule {
  /** Issues this rule checks: their origin id starts with this. */
  originPrefix: string;
  /** The kind of work, e.g. "Drafts to send". */
  label: string;
  check: (issue: DoneCheckIssue, ctx: PluginContext) => Promise<DoneCheckResult>;
}

export type DoneCheckOutcome = "skipped" | "passed" | "reopened" | "escalated";

/** Failed closes before the issue goes to the Operator instead of back to the agent. */
export const DONE_CHECK_MAX_REOPENS = 3;

const attemptsKey = (companyId: string, issueId: string) => ({ scopeKind: "company" as const, scopeId: companyId, namespace: "pib-done-checks", stateKey: issueId });

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `plugin:<this plugin's key>`, the origin kind the host gives the issues this plugin opens. */
function ownOriginKind(ctx: PluginContext): string | null {
  try {
    const id = (ctx as { manifest?: { id?: string } }).manifest?.id;
    return id ? `plugin:${id}` : null;
  } catch {
    return null;
  }
}

/** Runs the matching rule for one `issue.updated` event. Exported for tests. */
export async function runDoneCheck(ctx: PluginContext, rules: DoneCheckRule[], event: Pick<PluginEvent, "entityId" | "companyId" | "actorType">): Promise<DoneCheckOutcome> {
  if (event.actorType !== "agent" || !event.entityId || !event.companyId) return "skipped";
  const companyId = event.companyId;
  const raw = await ctx.issues.get(event.entityId, companyId);
  if (!raw || raw.status !== "done") return "skipped";
  // Only issues this plugin opened: every plugin hears every close, and two
  // plugins may use the same origin id prefix (the hire flow's "hire:" is shared).
  const originKind = (raw as { originKind?: string | null }).originKind;
  const own = ownOriginKind(ctx);
  if (originKind && own && originKind !== own && !originKind.startsWith(`${own}:`)) return "skipped";
  const originId = (raw as { originId?: string | null }).originId ?? null;
  const rule = rules.find((r) => originId?.startsWith(r.originPrefix));
  if (!rule) return "skipped";
  const issue: DoneCheckIssue = {
    id: raw.id,
    companyId,
    identifier: (raw as { identifier?: string | null }).identifier ?? null,
    title: raw.title,
    originKind: originKind ?? null,
    originId,
    assigneeAgentId: raw.assigneeAgentId ?? null,
    createdAt: raw.createdAt ? new Date(raw.createdAt as unknown as string).toISOString() : null,
  };
  const result = await rule.check(issue, ctx);
  const key = attemptsKey(companyId, issue.id);
  if (result.done) {
    await ctx.state.set(key, 0).catch(() => undefined);
    return "passed";
  }
  const attempts = Number((await ctx.state.get(key).catch(() => 0)) ?? 0) + 1;
  await ctx.state.set(key, attempts).catch(() => undefined);
  const missing = result.missing?.length ? result.missing : ["The work this issue asks for is not finished yet."];
  const list = missing.map((line) => `- ${line}`).join("\n");

  if (attempts >= DONE_CHECK_MAX_REOPENS) {
    const route = await routeWork(ctx, companyId, ["operator"]);
    const handTo = route.via === "operator" ? "the Operator" : route.via === "owner" ? "the owner" : "nobody (no Operator or owner is set)";
    await ctx.issues.update(issue.id, { status: "todo", assigneeAgentId: route.assigneeAgentId, assigneeUserId: route.assigneeUserId }, companyId);
    await ctx.issues.createComment(
      issue.id,
      `**Still not done** (${rule.label}), after ${attempts} tries:\n${list}\n\nHanding this to ${handTo} to sort out why it keeps getting closed early.`,
      companyId,
    );
    if (route.assigneeAgentId) await wakeIssue(ctx, issue.id, companyId, "Done check: closed early again");
    return "escalated";
  }

  await ctx.issues.update(issue.id, { status: "todo" }, companyId);
  await ctx.issues.createComment(
    issue.id,
    `**Not done yet** (${rule.label}):\n${list}\n\nThe issue is open again. Finish these, then close it.`,
    companyId,
  );
  if (issue.assigneeAgentId) await wakeIssue(ctx, issue.id, companyId, "Done check: not finished");
  return "reopened";
}

/**
 * Runs the done-checks for one `issue.updated` event and logs a failure. Call it
 * from the plugin's own `issue.updated` handler when it has one: every
 * `ctx.events.on` is a separate host subscription, and the worker runs all of a
 * plugin's handlers for each one, so a second subscription runs everything twice.
 */
export async function checkDoneOnUpdate(ctx: PluginContext, rules: DoneCheckRule[], event: PluginEvent): Promise<void> {
  if (rules.length === 0) return;
  try {
    await runDoneCheck(ctx, rules, event);
  } catch (error) {
    ctx.logger.info("Done check failed", { issueId: event.entityId, error: message(error) });
  }
}

/**
 * Checks agents' closes of this plugin's issues, for a plugin with no other
 * `issue.updated` handler (call once in setup). A plugin that already listens
 * calls `checkDoneOnUpdate` from that handler instead (see above).
 */
export function registerDoneChecks(ctx: PluginContext, rules: DoneCheckRule[]): void {
  if (rules.length === 0) return;
  ctx.events.on("issue.updated", (event: PluginEvent) => checkDoneOnUpdate(ctx, rules, event));
}
