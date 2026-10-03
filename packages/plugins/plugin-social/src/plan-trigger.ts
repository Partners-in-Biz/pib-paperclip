/**
 * The first plan for a scope.
 *
 * The weekly "Weekly social review & plan" routine only runs Mondays, so a
 * scope whose first account connects on a Tuesday would wait nearly a week
 * (and a routine that fails would leave it waiting for good). Whenever an
 * account is saved, and from the hourly job as a safety net, a scope that has
 * a live account but no posts and no earlier plan gets ONE "Plan social for
 * <client or own work>" issue for the Social agent. Posts of any kind
 * (except RSS and reply drafts) mean the scope already has a plan; the weekly
 * routine takes over from there.
 *
 * Once per scope: the claim is a `handoffs` row (kind `plan`, key
 * `plan:<company>:<scope>`) written before the issue is opened, the same way
 * the SEO repurpose task is claimed, so two connects (a Meta picker saves a
 * Facebook page and an Instagram account together) and a connect racing the
 * hourly sweep open one issue. Nothing is opened when no agent would take it
 * (the weekly routine and the hire flow cover that), and nothing is claimed
 * until one would.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { clientWhere, parseClientParam, type ClientScope } from "@partnersinbiz/pib-plugin-kit";
import { OWN, rowScope, scopeColumns, scopeLabel, type ResolvedScope } from "./clients.js";
import { table } from "./db.js";
import { clip } from "./domain.js";
import { createIssueSafely, ORIGIN_KIND, scopeLine, SOCIAL_ORIGINS, socialAssignee, socialProjectId } from "./issues.js";
import { socialOn } from "./modules.js";
import { isSocialPlatform, PLATFORM_LABELS } from "./platforms.js";

/** `handoffs.kind` of a plan claim. */
export const PLAN_HANDOFF_KIND = "plan";
/** A claim without an issue older than this is taken over (a crash between claim and create). */
const CLAIM_TAKEOVER = "10 minutes";
/** Scopes one sweep looks at per company. */
const SWEEP_SCOPES = 25;

/** `own`, `company:<id>` or `contact:<id>`: the scope as it appears in the origin id. */
export function planScopeKey(scope: ClientScope): string {
  return scope ? `${scope.kind}:${scope.id}` : "own";
}

/** The scope named by a plan origin id's key (`own`, `company:<id>`, `contact:<id>`); `undefined` when it names none. */
export function planScopeOfKey(key: string): ClientScope | undefined {
  if (key === "own") return null;
  return parseClientParam(key) ?? undefined;
}

export function planClaimKey(companyId: string, scope: ClientScope): string {
  return `plan:${companyId}:${planScopeKey(scope)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LiveAccount {
  platform: string;
  display_name: string;
}

/**
 * Accounts of a scope that can publish now: connected or about to expire (not
 * disconnected, disabled or needing a reconnect), and company or client pages
 * (`org`): a person's own profile only takes that person's own posts, never a plan.
 */
export async function liveAccountsInScope(ctx: PluginContext, companyId: string, scope: ClientScope): Promise<LiveAccount[]> {
  const w = clientWhere(scope, 2);
  return ctx.db.query<LiveAccount>(
    `SELECT platform, display_name FROM ${table(ctx, "accounts")}
      WHERE company_id = $1 AND token_enc IS NOT NULL AND status IN ('connected', 'expiring') AND scope = 'org' AND ${w.sql}
      ORDER BY platform, display_name LIMIT 50`,
    [companyId, ...w.params],
  );
}

/**
 * Posts made in a scope by an agent or a person (RSS and reply drafts do not
 * count: they are not a plan), since `sinceIso` when given. A post of any
 * status counts: a draft that went on to be published was drafted.
 */
export async function postsMadeInScope(ctx: PluginContext, companyId: string, scope: ClientScope, sinceIso: string | null): Promise<number> {
  const w = clientWhere(scope, 2);
  const params: unknown[] = [companyId, ...w.params];
  let since = "";
  if (sinceIso) {
    params.push(sinceIso);
    since = ` AND created_at >= $${params.length}::timestamptz`;
  }
  const rows = await ctx.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ${table(ctx, "posts")}
      WHERE company_id = $1 AND source NOT IN ('rss', 'inbox_reply') AND ${w.sql}${since}`,
    params,
  );
  const n = Number(rows[0]?.n ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function platformLine(accounts: LiveAccount[]): string {
  const names = accounts.slice(0, 8).map((a) => `${isSocialPlatform(a.platform) ? PLATFORM_LABELS[a.platform] : a.platform} (${clip(a.display_name, 60)})`);
  return `Connected accounts: ${names.join(", ")}${accounts.length > 8 ? `, and ${accounts.length - 8} more` : ""}.`;
}

/** Issue text for the Social agent. Pure. */
export function planDescription(target: ResolvedScope, accounts: LiveAccount[]): string {
  const row = scopeColumns(target);
  const who = target.scope ? `${scopeLabel(target)} has connected social accounts` : "PiB's own social accounts are connected";
  return [
    `${who} and no plan yet: nothing has been drafted for ${target.scope ? "this client" : "them"}. Start the first plan now; the weekly "Weekly social review & plan" routine (Mondays 07:00) takes over after that.`,
    "",
    platformLine(accounts),
    scopeLine(row),
    "",
    "Do this, in this scope only (procedure details: the pib-social-content skill, \"Weekly social review & plan\"):",
    "1. `list-connected-accounts` for this scope. Plan only for accounts that are connected; skip any that need reconnecting.",
    "2. `get-playbook` for this scope (it starts with the standard playbook). `performance-review` only if posts have been published already.",
    "3. Draft next week's posts for each connected platform with `create-post`, following the playbook, each with a proposed time (`scheduledAt`). `validate-post`, fix every problem, then `request-review`.",
    "4. Never approve a post: a person approves every post, and approval schedules it at its proposed time.",
    "5. Close this issue with one line: the posts drafted per platform and anything the approver must decide. The close is checked: at least one post must exist in this scope that was drafted after this issue opened.",
    "",
    `Plan key: \`${SOCIAL_ORIGINS.plan}${planScopeKey(target.scope)}\``,
  ].join("\n");
}

export type PlanOutcome =
  | { status: "opened" | "exists"; issueId: string }
  | { status: "off" | "no-accounts" | "planned" | "no-agent" | "busy" };

/**
 * Open the scope's first plan issue unless it has one or needs none. Safe to
 * call as often as you like. Throws on a database or host failure (`startPlan`
 * and `planSweep` catch).
 */
export async function ensurePlanForScope(ctx: PluginContext, companyId: string, target: ResolvedScope): Promise<PlanOutcome> {
  if (!(await socialOn(ctx, companyId))) return { status: "off" };
  const { scope } = target;
  const handoffs = table(ctx, "handoffs");
  const key = planClaimKey(companyId, scope);
  const claimed = await ctx.db.query<{ issue_id: string | null }>(`SELECT issue_id FROM ${handoffs} WHERE key = $1 AND company_id = $2 LIMIT 1`, [key, companyId]);
  if (claimed[0]?.issue_id) return { status: "exists", issueId: claimed[0].issue_id };

  const accounts = await liveAccountsInScope(ctx, companyId, scope);
  if (accounts.length === 0) return { status: "no-accounts" };
  if ((await postsMadeInScope(ctx, companyId, scope, null)) > 0) return { status: "planned" };

  // The agent comes before the claim: with nobody to plan, the claim would only hide the scope from the next try.
  const assignee = await socialAssignee(ctx, companyId);
  if (!assignee.assigneeAgentId) return { status: "no-agent" };

  const claim = await ctx.db.execute(
    `INSERT INTO ${handoffs} AS h (key, company_id, kind, payload) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (key) DO UPDATE SET claimed_at = now()
      WHERE h.issue_id IS NULL AND h.claimed_at < now() - interval '${CLAIM_TAKEOVER}'`,
    [key, companyId, PLAN_HANDOFF_KIND, JSON.stringify({ scope: planScopeKey(scope), clientName: target.client?.name ?? null })],
  );
  if ((claim.rowCount ?? 0) === 0) {
    const row = await ctx.db.query<{ issue_id: string | null }>(`SELECT issue_id FROM ${handoffs} WHERE key = $1 AND company_id = $2 LIMIT 1`, [key, companyId]);
    // Another run holds the claim and has not finished: it opens the issue.
    return row[0]?.issue_id ? { status: "exists", issueId: row[0].issue_id } : { status: "busy" };
  }

  const issue = await createIssueSafely(ctx, {
    companyId,
    projectId: await socialProjectId(ctx, companyId),
    title: `Plan social for ${scopeLabel(target)}`,
    description: planDescription(target, accounts),
    priority: "medium",
    originKind: ORIGIN_KIND,
    originId: `${SOCIAL_ORIGINS.plan}${planScopeKey(scope)}`,
    assigneeAgentId: assignee.assigneeAgentId,
    assigneeUserId: assignee.assigneeUserId,
    wakeReason: "First social plan for a connected scope",
  });
  await ctx.db.execute(`UPDATE ${handoffs} SET issue_id = $3 WHERE key = $1 AND company_id = $2`, [key, companyId, issue.id]);
  return { status: "opened", issueId: issue.id };
}

/** `ensurePlanForScope` for the connect flow: never throws, so a failed plan never fails the connection. */
export async function startPlan(ctx: PluginContext, companyId: string, target: ResolvedScope): Promise<PlanOutcome | null> {
  try {
    const outcome = await ensurePlanForScope(ctx, companyId, target);
    if (outcome.status === "opened") ctx.logger.info("Opened the first social plan", { companyId, scope: planScopeKey(target.scope), issueId: outcome.issueId });
    return outcome;
  } catch (error) {
    ctx.logger.info("First social plan not opened; the hourly check tries again", { companyId, scope: planScopeKey(target.scope), error: errorMessage(error) });
    return null;
  }
}

/**
 * Hourly safety net for one company: every scope with a live account gets its
 * first plan (accounts connected before this existed, a connect whose plan
 * failed, an agent linked after the account).
 */
export async function planSweep(ctx: PluginContext, companyId: string): Promise<{ scopes: number; opened: number }> {
  const result = { scopes: 0, opened: 0 };
  try {
    const rows = await ctx.db.query<{ client_kind: string | null; client_ref: string | null; client_name: string | null }>(
      `SELECT client_kind, client_ref, max(client_name) AS client_name FROM ${table(ctx, "accounts")}
        WHERE company_id = $1 AND token_enc IS NOT NULL AND status IN ('connected', 'expiring') AND scope = 'org'
        GROUP BY client_kind, client_ref ORDER BY client_ref NULLS FIRST LIMIT ${SWEEP_SCOPES}`,
      [companyId],
    );
    for (const row of rows) {
      result.scopes += 1;
      const target = row.client_ref ? rowScope(row) : OWN;
      if ((await startPlan(ctx, companyId, target))?.status === "opened") result.opened += 1;
    }
  } catch (error) {
    ctx.logger.info("Social plan sweep skipped", { companyId, error: errorMessage(error) });
  }
  return result;
}
