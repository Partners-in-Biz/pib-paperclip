/**
 * Connecting an account closes the loop it was asked for (Q9-10).
 *
 * The gap. An agent that needs an account asks the owner once (`ask-owner`, with the deep
 * link `connect-account` returns). The owner signs in on the Social page, and nothing told
 * the agent: its issue sat in the owner's queue until somebody noticed, and a reconnect
 * issue stayed open after the account was working again.
 *
 * The loop now:
 * 1. `connect-account` records the wish (`connect_requests`: platform, scope, the agent and
 *    the issue it is working on, read from its run).
 * 2. When the connect flow saves an account (a first connection or a reconnect: OAuth, the
 *    account picker, Bluesky) `resolveConnectRequests` closes the matching open requests:
 *    a comment on the asking issue, the issue handed back to the agent when the ask had
 *    handed it to the owner (the Cockpit then settles its ask: handing an issue to an agent
 *    resolves it), and a wake-up. It also closes the account's own "Reconnect ..." issue.
 * 3. An ask can carry the effect `social.connect-account` (platform + client): when the owner
 *    answers "done", the effect checks the account really is connected and says so, instead of
 *    the agent finding out by trial. It changes nothing; it only reads.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { checkEffectParams, clientWhere, formatClientParam, wakeIssue, type AskEffectHandler, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { randomUUID } from "node:crypto";
import { listAccounts, table } from "./db.js";
import { isSocialPlatform, PLATFORM_LABELS, ALL_PLATFORMS } from "./platforms.js";

export const CONNECT_EFFECT_KEY = "social.connect-account";

const CLOSED = new Set(["done", "cancelled"]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function platformName(platform: string): string {
  return isSocialPlatform(platform) ? PLATFORM_LABELS[platform] : platform;
}

/** The issue an agent's run is working on (the host's run context), or null. Never throws. */
export async function issueOfRun(ctx: PluginContext, companyId: string, agentId: string | null, runId: string | null): Promise<string | null> {
  if (!agentId || !runId) return null;
  try {
    const rows = await ctx.db.query<{ issue_id: string | null }>(
      "SELECT context_snapshot->>'issueId' AS issue_id FROM public.heartbeat_runs WHERE id = $1 AND company_id = $2 AND agent_id = $3 LIMIT 1",
      [runId, companyId, agentId],
    );
    const id = rows[0]?.issue_id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export interface ConnectWish {
  platform: string;
  scope: ClientScope;
  clientName: string | null;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
}

/** Records that an agent asked for this connection. One open request per platform, scope and issue: asking again only refreshes the run. */
export async function recordConnectRequest(ctx: PluginContext, companyId: string, wish: ConnectWish): Promise<{ id: string | null; issueId: string | null }> {
  if (!wish.issueId) return { id: null, issueId: null };
  const requests = table(ctx, "connect_requests");
  try {
    const params: unknown[] = [companyId, wish.platform, wish.issueId];
    const w = clientWhere(wish.scope, params.length + 1);
    params.push(...w.params);
    const existing = await ctx.db.query<{ id: string }>(
      `SELECT id FROM ${requests} WHERE company_id = $1 AND status = 'open' AND platform = $2 AND issue_id = $3 AND ${w.sql} LIMIT 1`,
      params,
    );
    if (existing[0]) {
      await ctx.db.execute(`UPDATE ${requests} SET agent_id = $3, run_id = $4 WHERE id = $1 AND company_id = $2`, [existing[0].id, companyId, wish.agentId, wish.runId]);
      return { id: existing[0].id, issueId: wish.issueId };
    }
    const id = randomUUID();
    await ctx.db.execute(
      `INSERT INTO ${requests} (id, company_id, platform, client_kind, client_ref, client_name, agent_id, run_id, issue_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, companyId, wish.platform, wish.scope?.kind ?? null, wish.scope?.id ?? null, wish.scope ? wish.clientName : null, wish.agentId, wish.runId, wish.issueId],
    );
    return { id, issueId: wish.issueId };
  } catch (error) {
    ctx.logger.info("Social connect request not recorded", { companyId, error: errorMessage(error) });
    return { id: null, issueId: wish.issueId };
  }
}

interface OpenRequest {
  id: string;
  issue_id: string | null;
  agent_id: string | null;
}

export interface ConnectedAccount {
  platform: string;
  accountId: string;
  displayName: string;
  scope: ClientScope;
  /** The account's own "Reconnect ..." issue, if it had one (read before the save cleared it). */
  reconnectIssueId?: string | null;
  reconnected: boolean;
}

/** The comment an asking issue gets. Pure. */
export function connectedComment(account: Pick<ConnectedAccount, "platform" | "displayName" | "scope" | "reconnected">, clientName: string | null): string {
  const where = account.scope ? (clientName ? `client ${clientName}` : formatClientParam(account.scope)) : "own work";
  return `**${account.reconnected ? "Reconnected" : "Connected"}:** ${platformName(account.platform)} · ${account.displayName} (${where}) is ${account.reconnected ? "signed in again" : "connected"}. You can carry on: \`list-connected-accounts\` shows it as connected, and nothing more is needed from the owner for this.`;
}

/**
 * Closes the open requests this connection answers and the account's reconnect issue.
 * Safe to call on every connect: with nothing waiting it does nothing. Never throws.
 */
export async function resolveConnectRequests(ctx: PluginContext, companyId: string, account: ConnectedAccount, clientName: string | null = null): Promise<{ resolved: number; reconnectClosed: boolean }> {
  const result = { resolved: 0, reconnectClosed: false };
  const requests = table(ctx, "connect_requests");
  try {
    const params: unknown[] = [companyId, account.platform];
    const w = clientWhere(account.scope, params.length + 1);
    params.push(...w.params);
    const open = await ctx.db.query<OpenRequest>(
      `SELECT id, issue_id, agent_id FROM ${requests} WHERE company_id = $1 AND status = 'open' AND platform = $2 AND ${w.sql} ORDER BY created_at LIMIT 20`,
      params,
    );
    for (const request of open) {
      const claim = await ctx.db.execute(
        `UPDATE ${requests} SET status = 'resolved', account_id = $3, resolved_at = now() WHERE id = $1 AND company_id = $2 AND status = 'open'`,
        [request.id, companyId, account.accountId],
      );
      if ((claim.rowCount ?? 0) !== 1) continue;
      result.resolved += 1;
      if (request.issue_id) await tellAskingIssue(ctx, companyId, request, connectedComment(account, clientName));
    }
  } catch (error) {
    ctx.logger.info("Social connect requests not resolved", { companyId, accountId: account.accountId, error: errorMessage(error) });
  }
  if (account.reconnectIssueId) result.reconnectClosed = await closeReconnectIssue(ctx, companyId, account.reconnectIssueId, account);
  return result;
}

/** Comment, hand the issue back to the asking agent when it sits with a person, and wake it. */
async function tellAskingIssue(ctx: PluginContext, companyId: string, request: OpenRequest, body: string): Promise<void> {
  const issueId = request.issue_id!;
  try {
    const issue = (await ctx.issues.get(issueId, companyId)) as { status?: string; assigneeAgentId?: string | null; assigneeUserId?: string | null } | null;
    if (!issue || CLOSED.has(String(issue.status))) return;
    await ctx.issues.createComment(issueId, body, companyId);
    // `ask-owner` hands the issue to the owner (in_review); a connection the owner made is the answer, so it goes back.
    const withPerson = Boolean(issue.assigneeUserId) && !issue.assigneeAgentId;
    const blocked = issue.status === "blocked";
    if ((withPerson || blocked) && request.agent_id) {
      await ctx.issues.update(issueId, { status: "todo", assigneeAgentId: request.agent_id, assigneeUserId: null }, companyId);
    }
    await wakeIssue(ctx, issueId, companyId, "The account you asked for is connected");
  } catch (error) {
    ctx.logger.info("Social connect: asking issue not updated", { issueId, error: errorMessage(error) });
  }
}

async function closeReconnectIssue(ctx: PluginContext, companyId: string, issueId: string, account: ConnectedAccount): Promise<boolean> {
  try {
    const issue = (await ctx.issues.get(issueId, companyId)) as { status?: string } | null;
    if (!issue || CLOSED.has(String(issue.status))) return false;
    await ctx.issues.createComment(issueId, `${platformName(account.platform)} · ${account.displayName} is signed in again. Closing this issue.`, companyId);
    await ctx.issues.update(issueId, { status: "done" }, companyId);
    return true;
  } catch (error) {
    ctx.logger.info("Social reconnect issue not closed", { issueId, error: errorMessage(error) });
    return false;
  }
}

// ── the ask effect ──────────────────────────────────────────────────────────

const CLIENT_PARAM = /^(own|(company|contact):[A-Za-z0-9_-]{1,128})$/;

/**
 * `social.connect-account`: the owner answered an ask for a connection. Reads the accounts
 * of the named scope and platform: connected means done, anything else is reported as not done
 * (the agent is told what the page shows). Changes nothing; params are whitelisted.
 */
export const connectEffect: AskEffectHandler = {
  validate: ({ ask }) => {
    const checked = checkEffectParams(ask.effect.params, {
      platform: { required: true, type: "string", oneOf: ALL_PLATFORMS },
      client: { type: "string", pattern: CLIENT_PARAM, maxLength: 160 },
    });
    return checked.ok ? null : checked.problems.join("; ");
  },
  async apply({ ctx, companyId, ask }) {
    const platform = String(ask.effect.params?.platform);
    const client = typeof ask.effect.params?.client === "string" ? ask.effect.params.client : "own";
    const scope: ClientScope = client === "own" ? null : { kind: client.startsWith("contact:") ? "contact" : "company", id: client.slice(client.indexOf(":") + 1) };
    const live = (await listAccounts(ctx, companyId, scope)).filter((a) => a.platform === platform && a.token_enc && (a.status === "connected" || a.status === "expiring"));
    if (live.length === 0) {
      const stale = (await listAccounts(ctx, companyId, scope)).filter((a) => a.platform === platform);
      const why = stale.length ? `${stale.length} ${platformName(platform)} account(s) exist but ${stale[0]!.status === "needs_reconnect" ? "need reconnecting" : "are not connected"}` : `no ${platformName(platform)} account is connected`;
      throw new Error(`${why} in ${client === "own" ? "own work" : client} yet: the sign-in was not completed. The owner opens Social → Accounts and connects it.`);
    }
    return { detail: `${platformName(platform)} · ${live.map((a) => a.display_name).join(", ")} is connected (${client === "own" ? "own work" : client}).` };
  },
  async verify({ ctx, companyId, ask }) {
    const platform = String(ask.effect.params?.platform);
    const client = typeof ask.effect.params?.client === "string" ? ask.effect.params.client : "own";
    const scope: ClientScope = client === "own" ? null : { kind: client.startsWith("contact:") ? "contact" : "company", id: client.slice(client.indexOf(":") + 1) };
    return (await listAccounts(ctx, companyId, scope)).some((a) => a.platform === platform && a.token_enc && (a.status === "connected" || a.status === "expiring"));
  },
};
