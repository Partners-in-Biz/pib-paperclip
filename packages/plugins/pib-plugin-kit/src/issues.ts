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
        error: error instanceof Error ? error.message : String(error),
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
    ctx.logger.info("Issue wakeup skipped", { issueId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
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
    ctx.logger.info("Could not hand the approval back to a person", { issueId: input.issueId, error: error instanceof Error ? error.message : String(error) });
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
    ctx.logger.info("Could not comment on the reopened approval", { issueId: input.issueId, error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
