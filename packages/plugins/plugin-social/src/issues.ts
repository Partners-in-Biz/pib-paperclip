/**
 * Paperclip issues opened by the social plugin: one per failed post and one
 * per account that needs reconnecting. Agent-assigned issues are `todo` and
 * woken (kit createWorkIssue); plugin-created issues do not wake on their own.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, companyRoles, createWorkIssue, linkedAgentId, routeWork } from "@partnersinbiz/pib-plugin-kit";
import { clientPrefix, formatClientParam, scopeOfRow } from "./clients.js";
import type { AccountRow, DestinationRow, PostRow } from "./db.js";
import { legacySocialAgent, SOCIAL_HIRE_ROLE } from "./hire.js";
import { PLATFORM_LABELS, PLUGIN_ID, SOCIAL_AGENT_KEY, SOCIAL_PROJECT_KEY, isSocialPlatform } from "./platforms.js";

export { SOCIAL_AGENT_KEY, SOCIAL_PROJECT_KEY };
export const ORIGIN_KIND = `plugin:${PLUGIN_ID}` as const;

/** The company's default person, then the Cockpit owner: who gets person-only work nobody else owns. */
export async function fallbackPerson(ctx: PluginContext, companyId: string): Promise<string | undefined> {
  try {
    const person = (await ctx.companies.get(companyId))?.defaultResponsibleUserId;
    if (person) return person;
  } catch {
    // fall through to the Cockpit owner
  }
  return (await companyRoles(ctx, companyId))?.ownerUserId ?? undefined;
}

export interface SocialAssignee {
  assigneeAgentId?: string;
  assigneeUserId?: string;
  /** `social` (the Social agent), another kit role (the Operator), `person`, or `none`. */
  via: string;
}

/**
 * Who gets Social agent work: the linked Social agent when it runs, else the
 * kit route (a running Social agent the Cockpit knows, else the Operator),
 * else `person` (who owns the account or post), else the company's default
 * person or the Cockpit owner. Nothing is left unassigned when anyone exists.
 */
export async function socialAssignee(ctx: PluginContext, companyId: string, person?: string | null): Promise<SocialAssignee> {
  const agent = await socialAgent(ctx, companyId);
  if (agent.active && agent.agentId) return { assigneeAgentId: agent.agentId, via: "social" };
  const route = await routeWork(ctx, companyId, ["social"]).catch(() => null);
  if (route?.assigneeAgentId) return { assigneeAgentId: route.assigneeAgentId, via: route.via };
  const userId = person ?? (await fallbackPerson(ctx, companyId)) ?? route?.assigneeUserId ?? undefined;
  return userId ? { assigneeUserId: userId, via: "person" } : { via: "none" };
}

/** A person decides (risky comments, reconnects): `person` if known, else the default person or the Cockpit owner. */
export async function personAssignee(ctx: PluginContext, companyId: string, person?: string | null): Promise<string | undefined> {
  return person ?? (await fallbackPerson(ctx, companyId));
}

const INACTIVE_AGENT = new Set(["paused", "terminated", "pending_approval", "archived", "deleted"]);

/** True when an agent in this status picks up work. */
export function agentStatusActive(status: string | null | undefined): boolean {
  return Boolean(status && !INACTIVE_AGENT.has(status));
}

/**
 * The agent Social work goes to: the one linked through the hire flow (or by
 * hand), else one the host created from the manifest before hiring moved to
 * tasks.
 */
export async function socialAgent(ctx: PluginContext, companyId: string): Promise<{ agentId: string | null; active: boolean; status: string | null }> {
  try {
    const agentId = await linkedAgentId(ctx, companyId, SOCIAL_HIRE_ROLE, legacySocialAgent(ctx));
    if (!agentId) return { agentId: null, active: false, status: null };
    const agent = await ctx.agents.get(agentId, companyId);
    const status = agent?.status ?? null;
    return { agentId, active: agentStatusActive(status), status };
  } catch {
    return { agentId: null, active: false, status: null };
  }
}

export async function socialProjectId(ctx: PluginContext, companyId: string): Promise<string | undefined> {
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

type WorkIssueInput = Parameters<typeof createWorkIssue>[1];

/**
 * createWorkIssue, retried without the assignee when the host refuses it
 * (e.g. a default person who is no longer a member), so the work is not lost.
 */
export async function createIssueSafely(ctx: PluginContext, input: WorkIssueInput): Promise<{ id: string; woke: boolean }> {
  try {
    return await createWorkIssue(ctx, input);
  } catch (error) {
    if (!input.assigneeUserId && !input.assigneeAgentId) throw error;
    ctx.logger.info("Issue assignee refused; creating it unassigned", { title: input.title, error: error instanceof Error ? error.message : String(error) });
    return createWorkIssue(ctx, { ...input, assigneeUserId: undefined, assigneeAgentId: undefined, wake: false });
  }
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
  const assignee = await socialAssignee(ctx, companyId, post.owner_user_id);
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
    "1. Read the error with `get-post`.",
    "2. Token or permission errors: the account needs a person to sign in again (a one-time grant). The hourly token job opens a \"Reconnect …\" issue for them; check `list-connected-accounts` shows it as needs_reconnect. If no reconnect issue exists, ask once with `" + ASK_OWNER_TOOL + "` and the Social → Accounts link. Retry with `retry-post` once it is connected again.",
    "3. Content errors (too long, missing media, wrong format): move the post back to draft, fix the per-platform override, and send it for review again; approval schedules it at its proposed time.",
    "4. Transient errors (timeouts, rate limits, 5xx): `retry-post`.",
    "Destinations that already published are never published again. Close this issue with what you did.",
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
      assigneeAgentId: assignee.assigneeAgentId,
      assigneeUserId: assignee.assigneeUserId,
      wakeReason: "Social post failed to publish",
    });
    return issue.id;
  } catch (error) {
    ctx.logger.info("Could not open the publish failure issue", { companyId, postId: post.id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export async function openReconnectIssue(ctx: PluginContext, companyId: string, account: AccountRow, reason: string): Promise<string | null> {
  // Signing in again is a person's one-time grant: whoever connected it, else the default person or the Cockpit owner.
  const assigneeUserId = await personAssignee(ctx, companyId, account.created_by_user_id);
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
