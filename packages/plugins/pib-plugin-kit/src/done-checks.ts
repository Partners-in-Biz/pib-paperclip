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
 * To stop a loop, the third failed close escalates the issue to the next
 * manager in the chain, or to the owner (creating an Unblock issue).
 * If escalation is disabled, it falls back to routing to the Operator.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { escalate } from "./escalate.js";
import { routeWork } from "./cockpit.js";
import { wakeIssueWhenIdle } from "./issues.js";

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
  /** Matches any issue by its content instead of its origin id (`originPrefix` is then ignored, use ""). Runs on every agent close in the company, so keep it cheap and synchronous. */
  match?: (issue: { title: string; description?: string | null; originKind?: string | null; originId: string | null }) => boolean;
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
  const originId = (raw as { originId?: string | null }).originId ?? null;
  // For match rules, compute foreign only when needed (origin rules only).
  // Match rules run even on foreign plugin origins.
  const rule = rules.find((r) => {
    if (r.match) return r.match({ title: raw.title, description: (raw as { description?: string | null }).description ?? null, originKind: originKind ?? null, originId });
    // Origin rule: skip foreign origins (not opened by this plugin)
    if (originKind && own && originKind !== own && !originKind.startsWith(`${own}:`)) return false;
    return originId?.startsWith(r.originPrefix);
  });
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

  async function routeToOperator(ruleLabel: string) {
    const route = await routeWork(ctx, companyId, ["operator"]);
    const handTo = route.via === "operator" ? "the Operator" : route.via === "owner" ? "the owner" : "nobody (no Operator or owner is set)";
    await ctx.issues.update(issue.id, { status: "todo", assigneeAgentId: route.assigneeAgentId, assigneeUserId: route.assigneeUserId }, companyId);
    await ctx.issues.createComment(
      issue.id,
      `**Still not done** (${ruleLabel}), after ${attempts} tries:\n${list}\n\nHanding this to ${handTo} to sort out why it keeps getting closed early.`,
      companyId,
    );
    if (route.assigneeAgentId) await wakeIssueWhenIdle(ctx, issue.id, companyId, "Done check: closed early again");
  }

  if (attempts >= DONE_CHECK_MAX_REOPENS) {
    // Escalate to the next manager in the chain, or to the owner
    const escalateResult = await escalate(ctx, issue.id, "done_check_early_close", { companyId });

    if ("id" in escalateResult) {
      // Escalation succeeded (created or dedupe): issue is now blocked with an Unblock issue
      const unblockId = escalateResult.id;

      // If dedupe, check if issue is already blocked; if so, return without posting another comment
      if (!escalateResult.created) {
        const currentIssue = await ctx.issues.get(issue.id, companyId);
        // If issue is already blocked from previous escalation, no need for a comment
        if (currentIssue && currentIssue.status === "blocked") {
          return "escalated";
        }

        // Ensure issue is blocked (escalate only updates on creation)
        await ctx.issues.update(issue.id, { status: "blocked" }, companyId);
        // Post message for dedupe (issue was not yet blocked)
        await ctx.issues.createComment(
          issue.id,
          `**Still not done** (${rule.label}), after ${attempts} tries:\n${list}\n\nAlready escalated; waiting for resolution.`,
          companyId,
        );
      } else {
        // Post message for new escalation, with the assignee name
        const unblockIssue = await ctx.issues.get(unblockId, companyId);
        let assigneeName = "an Unblock issue";
        if (unblockIssue) {
          if (unblockIssue.assigneeAgentId) {
            const assigneeAgent = await ctx.agents.get(unblockIssue.assigneeAgentId, companyId);
            if (assigneeAgent && typeof assigneeAgent.name === "string") {
              assigneeName = `${assigneeAgent.name} (in Unblock issue ${unblockId})`;
            } else {
              assigneeName = `the manager (in Unblock issue ${unblockId})`;
            }
          } else if (unblockIssue.assigneeUserId) {
            assigneeName = `the owner (in Unblock issue ${unblockId})`;
          }
        }
        await ctx.issues.createComment(
          issue.id,
          `**Still not done** (${rule.label}), after ${attempts} tries:\n${list}\n\nEscalating to ${assigneeName} for further investigation.`,
          companyId,
        );
      }
      return "escalated";
    }

    if ("skipped" in escalateResult && escalateResult.skipped === "disabled") {
      // Escalation is disabled: fall back to old behavior (route to operator)
      await routeToOperator(rule.label);
      return "escalated";
    }

    if ("skipped" in escalateResult && escalateResult.skipped === "cap") {
      // Daily cap reached: keep issue blocked, don't create duplicate operator assignment
      const currentIssue = await ctx.issues.get(issue.id, companyId);
      // If issue is already blocked, no need for a comment
      if (currentIssue && currentIssue.status === "blocked") {
        return "escalated";
      }
      // Ensure issue is blocked
      if (currentIssue) {
        await ctx.issues.update(issue.id, { status: "blocked" }, companyId);
      }
      // Post message (issue was not yet blocked)
      await ctx.issues.createComment(
        issue.id,
        `**Still not done** (${rule.label}), after ${attempts} tries:\n${list}\n\nAlready escalated; waiting for resolution.`,
        companyId,
      );
      return "escalated";
    }

    if ("skipped" in escalateResult && (escalateResult.skipped === "no-target" || escalateResult.skipped === "no-owner" || escalateResult.skipped === "no-issue")) {
      // No escalation target available: fall back to operator routing
      await routeToOperator(rule.label);
      return "escalated";
    }

    // Unexpected skip reason (should not happen with current code)
    // Fall back to operator routing as a safety net
    await routeToOperator(rule.label);
    return "escalated";
  }

  await ctx.issues.update(issue.id, { status: "todo" }, companyId);
  await ctx.issues.createComment(
    issue.id,
    `**Not done yet** (${rule.label}):\n${list}\n\nThe issue is open again. Finish these, then close it.`,
    companyId,
  );
  if (issue.assigneeAgentId) await wakeIssueWhenIdle(ctx, issue.id, companyId, "Done check: not finished");
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
    ctx.logger.info("Done check failed", { issueId: event.entityId, stage: "check", reason: message(error) });
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
