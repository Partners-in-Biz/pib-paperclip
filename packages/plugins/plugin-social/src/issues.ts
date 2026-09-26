/**
 * Paperclip issues opened by the social plugin: one per failed post and one
 * per account that needs reconnecting. Agent-assigned issues are `todo` and
 * woken (kit createWorkIssue); plugin-created issues do not wake on their own.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { createWorkIssue } from "@partnersinbiz/pib-plugin-kit";
import { clientPrefix, formatClientParam, scopeOfRow } from "./clients.js";
import type { AccountRow, DestinationRow, PostRow } from "./db.js";
import { PLATFORM_LABELS, PLUGIN_ID, SOCIAL_AGENT_KEY, SOCIAL_PROJECT_KEY, isSocialPlatform } from "./platforms.js";

export { SOCIAL_AGENT_KEY, SOCIAL_PROJECT_KEY };
export const ORIGIN_KIND = `plugin:${PLUGIN_ID}` as const;

const INACTIVE_AGENT = new Set(["paused", "terminated", "pending_approval", "archived", "deleted"]);

export async function socialAgent(ctx: PluginContext, companyId: string): Promise<{ agentId: string | null; active: boolean; status: string | null }> {
  try {
    const res = await ctx.agents.managed.get(SOCIAL_AGENT_KEY, companyId);
    const status = res.agent?.status ?? null;
    return { agentId: res.agentId, active: Boolean(res.agentId && status && !INACTIVE_AGENT.has(status)), status };
  } catch {
    return { agentId: null, active: false, status: null };
  }
}

async function socialProjectId(ctx: PluginContext, companyId: string): Promise<string | undefined> {
  try {
    const res = await ctx.projects.managed.get(SOCIAL_PROJECT_KEY, companyId);
    return res.projectId ?? undefined;
  } catch {
    return undefined;
  }
}

function label(platform: string): string {
  return isSocialPlatform(platform) ? PLATFORM_LABELS[platform] : platform;
}

/** How an agent should scope its tool calls for this work. */
export function scopeLine(row: Pick<PostRow, "client_kind" | "client_ref" | "client_name">): string {
  const scope = scopeOfRow(row);
  if (!scope) return "Scope: own work (PiB's own accounts). Call the Social tools without a client.";
  return `Scope: client ${row.client_name ?? scope.id} — pass \`clientKind: "${scope.kind}"\`, \`clientRef: "${scope.id}"\` (or \`client: "${formatClientParam(scope)}"\`) to the Social tools. Use only this client's accounts and media.`;
}

export async function openPublishFailureIssue(
  ctx: PluginContext,
  input: {
    companyId: string;
    post: PostRow;
    failed: Array<{ destination: DestinationRow; account: AccountRow | null }>;
    published: number;
  },
): Promise<string | null> {
  const { companyId, post } = input;
  const agent = await socialAgent(ctx, companyId);
  const lines = input.failed.map(({ destination, account }) => {
    const who = account ? `${label(account.platform)} · ${account.display_name}` : `account ${destination.account_id}`;
    return `- **${who}**: ${destination.last_error ?? "failed"} (attempts: ${destination.attempts})`;
  });
  const excerpt = post.body.length > 280 ? `${post.body.slice(0, 280)}…` : post.body;
  const description = [
    `A scheduled social post did not publish to ${input.failed.length} destination${input.failed.length === 1 ? "" : "s"}` +
      (input.published ? ` (${input.published} published fine).` : "."),
    "",
    ...lines,
    "",
    scopeLine(post),
    `Post id: \`${post.id}\``,
    "",
    "> " + excerpt.replace(/\n/g, "\n> "),
    "",
    "What to do:",
    "1. Read the error. Token or permission errors mean the account must be reconnected on the Social page (Accounts tab).",
    "2. Content errors (too long, missing media, wrong format) need a fix: move the post back to draft, change the per-platform override, re-approve and schedule it.",
    "3. Transient errors can be retried with the `retry-post` tool or the Retry button on the post.",
    "Destinations that already published are never published again.",
  ].join("\n");
  try {
    const issue = await createWorkIssue(ctx, {
      companyId,
      projectId: await socialProjectId(ctx, companyId),
      title: `${clientPrefix(post)}Social post failed to publish`,
      description,
      priority: "high",
      originKind: ORIGIN_KIND,
      originId: post.id,
      assigneeAgentId: agent.active && agent.agentId ? agent.agentId : undefined,
      assigneeUserId: agent.active ? undefined : post.owner_user_id ?? undefined,
      wakeReason: "Social post failed to publish",
    });
    return issue.id;
  } catch (error) {
    ctx.logger.info("Could not open the publish failure issue", { companyId, postId: post.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function openReconnectIssue(ctx: PluginContext, companyId: string, account: AccountRow, reason: string): Promise<string | null> {
  let assigneeUserId: string | undefined = account.created_by_user_id ?? undefined;
  if (!assigneeUserId) {
    try {
      assigneeUserId = (await ctx.companies.get(companyId))?.defaultResponsibleUserId ?? undefined;
    } catch {
      assigneeUserId = undefined;
    }
  }
  try {
    const issue = await createWorkIssue(ctx, {
      companyId,
      projectId: await socialProjectId(ctx, companyId),
      title: `${clientPrefix(account)}Reconnect ${label(account.platform)}: ${account.display_name}`,
      description: [
        `The ${label(account.platform)} account **${account.display_name}**${account.client_ref ? ` (client ${account.client_name ?? account.client_ref})` : " (own work)"} needs to be reconnected.`,
        "",
        `Reason: ${reason}`,
        "",
        scopeLine(account),
        "",
        account.client_ref
          ? "Open the client's workspace from the CRM, go to Social → Accounts and click Reconnect on this account. Scheduled posts to it retry automatically for about an hour, then fail."
          : "Open the Social page, go to Accounts and click Reconnect on this account. Scheduled posts to it retry automatically for about an hour, then fail.",
      ].join("\n"),
      priority: "high",
      originKind: ORIGIN_KIND,
      originId: `account:${account.id}`,
      assigneeUserId,
      wake: false,
    });
    return issue.id;
  } catch (error) {
    ctx.logger.info("Could not open the reconnect issue", { companyId, accountId: account.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
