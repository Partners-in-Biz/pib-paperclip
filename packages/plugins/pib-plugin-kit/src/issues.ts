/**
 * Create a Paperclip issue for a person or an agent, and wake the agent.
 *
 * Issues created by a plugin do not wake their assignee on their own. An
 * agent-assigned issue must be `todo` (not backlog) and needs an explicit
 * `requestWakeup` (capability `issues.wakeup`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ownerUserFor } from "./cockpit.js";

type CreateInput = Parameters<PluginContext["issues"]["create"]>[0];

export async function createWorkIssue(
  ctx: PluginContext,
  input: CreateInput & { wake?: boolean; wakeReason?: string },
): Promise<{ id: string; woke: boolean }> {
  const { wake = true, wakeReason, ...create } = input;
  const issue = await ctx.issues.create({ status: "todo", ...create });
  let woke = false;
  if (wake && create.assigneeAgentId) {
    try {
      await ctx.issues.requestWakeup(issue.id, create.companyId, {
        reason: wakeReason ?? "Assigned by plugin",
        idempotencyKey: `wake:${issue.id}`,
      });
      woke = true;
    } catch (error) {
      ctx.logger.info("Issue wakeup skipped", {
        issueId: issue.id,
        stage: "wakeup",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { id: issue.id, woke };
}

export async function wakeIssue(ctx: PluginContext, issueId: string, companyId: string, reason: string): Promise<boolean> {
  try {
    await ctx.issues.requestWakeup(issueId, companyId, { reason, idempotencyKey: `wake:${issueId}:${Date.now()}` });
    return true;
  } catch (error) {
    ctx.logger.info("Issue wakeup skipped", { issueId, stage: "wakeup", reason: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

const IDLE_POLL_MS = 10_000;
const IDLE_MAX_WAIT_MS = 10 * 60_000;

/**
 * Wakes the assignee once the issue's current run has ended. A wake sent while
 * a run still holds the issue is coalesced into that run and lost, which is what
 * happens when an agent closes an issue and a check reopens it before the run
 * is over. Wakes now when no run holds the issue; otherwise polls in the
 * background (every 10 s, for up to 10 min) and wakes when it is free. The
 * wake sweeper picks it up if the worker restarts first. Returns true when it
 * woke now. `sleep` is injectable for tests.
 */
export async function wakeIssueWhenIdle(
  ctx: PluginContext,
  issueId: string,
  companyId: string,
  reason: string,
  options: { pollMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const pollMs = options.pollMs ?? IDLE_POLL_MS;
  const maxWaitMs = options.maxWaitMs ?? IDLE_MAX_WAIT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  const heldByRun = async (): Promise<boolean | "gone"> => {
    const issue = await ctx.issues.get(issueId, companyId).catch(() => undefined);
    if (!issue) return "gone";
    return Boolean((issue as { executionRunId?: string | null }).executionRunId);
  };
  const first = await heldByRun();
  if (first === "gone") return false;
  if (!first) return wakeIssue(ctx, issueId, companyId, reason);
  void (async () => {
    for (let waited = 0; waited < maxWaitMs; waited += pollMs) {
      await sleep(pollMs);
      const held = await heldByRun();
      if (held === "gone") return;
      if (!held) {
        await wakeIssue(ctx, issueId, companyId, reason);
        return;
      }
    }
    ctx.logger.info("Issue wakeup gave up waiting for the run to end", { issueId, stage: "wakeup" });
  })().catch((error) => ctx.logger.info("Issue wakeup wait failed", { issueId, stage: "wakeup", reason: error instanceof Error ? error.message : String(error) }));
  return false;
}

/**
 * Only a person decides an approval. When an agent (a Reviewer, or the agent
 * that asked) marks one done or cancelled, call this: the issue is reopened,
 * taken off the agent and handed to the person (`userId`, else the company
 * owner: the Cockpit roles, the host's default responsible user, then the last
 * owner this plugin saw), with a comment saying why. Returns false when
 * the host refused, so the caller can log it.
 */
export async function reopenApprovalForPerson(
  ctx: PluginContext,
  input: { issueId: string; companyId: string; userId?: string | null; what?: string | null },
): Promise<boolean> {
  // An approval is never right unassigned, so this path may use the last owner the plugin saw (like `resolveApprover`).
  const userId = input.userId ?? (await ownerUserFor(ctx, input.companyId, { lastKnown: true })).userId;
  try {
    await ctx.issues.update(input.issueId, { status: "todo", assigneeAgentId: null, assigneeUserId: userId }, input.companyId);
  } catch (error) {
    ctx.logger.info("Could not hand the approval back to a person", { issueId: input.issueId, stage: "reopen", reason: error instanceof Error ? error.message : String(error) });
    return false;
  }
  try {
    const what = input.what ? ` (${input.what})` : "";
    await ctx.issues.createComment(
      input.issueId,
      `An agent closed this approval${what}, so it is open again${userId ? " and assigned to its approver" : ""}. Only a person can decide it: mark it **done** to approve or **cancelled** to refuse.`,
      input.companyId,
    );
  } catch (error) {
    ctx.logger.info("Could not comment on the reopened approval", { issueId: input.issueId, stage: "reopen", reason: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
