/**
 * Create a Paperclip issue for a person or an agent, and wake the agent.
 *
 * Issues created by a plugin do not wake their assignee on their own. An
 * agent-assigned issue must be `todo` (not backlog) and needs an explicit
 * `requestWakeup` (capability `issues.wakeup`).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

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
