/**
 * The weekly growth review, worker part: reads this company's ledger and
 * metric scopes, groups them by who owns them and opens the issues
 * (`growth-review.ts` writes their text). Idempotent for the week by origin id.
 */
import { configSaved, createWorkIssue, type WorkRoute } from "@partnersinbiz/pib-plugin-kit";
import { teamRoleChain } from "@partnersinbiz/pib-plugin-kit/team";
import { ORIGIN, ORIGIN_ID } from "./constants.js";
import { listRoles } from "./db.js";
import type { Env } from "./env.js";
import { message, throwIfEveryCompanyFailed } from "./env.js";
import { listGoals } from "./goals.js";
import { channelRole, DEFAULT_OWN_CHANNELS, growthHandoffContent, growthReviewContent, type ReviewChannel, type ReviewScope } from "./growth-review.js";
import { linkFor } from "./health.js";
import { NAMESPACE } from "./namespace.js";
import { currentRoles, routeFromRoles } from "./roles.js";
import { mondayLabel, weekKey } from "./week.js";

type Raw = Record<string, unknown>;

export type GrowthReviewResult = { opened: number; existing: number };

const routeKey = (r: WorkRoute): string => r.assigneeAgentId ?? (r.assigneeUserId ? `user-${r.assigneeUserId}` : "nobody");

/** Every scope with a channel, from this company's ledger (this week's verdicts) and metric rows. `own` is always there. */
async function readScopes(env: Env, companyId: string, now: Date): Promise<ReviewScope[]> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const ledger = await env.ctx.db.query<Raw>(
    `SELECT channel, scope_key, experiment_id, verdict, relative_change, playbook_decision FROM ${NAMESPACE}.growth_ledger WHERE company_id = $1 AND decided_at >= $2 ORDER BY decided_at DESC`,
    [companyId, since],
  );
  const metrics = await env.ctx.db.query<Raw>(`SELECT DISTINCT channel, subject FROM ${NAMESPACE}.growth_metrics WHERE company_id = $1`, [companyId]);
  const scopes = new Map<string, Map<string, ReviewChannel>>([["own", new Map(DEFAULT_OWN_CHANNELS.map((c) => [c, { channel: c, ledger: [] }]))]]);
  const channelOf = (scope: string, channel: string): ReviewChannel => {
    const channels = scopes.get(scope) ?? scopes.set(scope, new Map()).get(scope)!;
    return channels.get(channel) ?? channels.set(channel, { channel, ledger: [] }).get(channel)!;
  };
  for (const m of metrics) channelOf(String(m.subject), String(m.channel));
  for (const r of ledger) {
    channelOf(String(r.scope_key), String(r.channel)).ledger.push({
      experimentId: String(r.experiment_id),
      verdict: r.verdict === null ? null : String(r.verdict),
      relativeChange: r.relative_change === null || r.relative_change === undefined ? null : Number(r.relative_change),
      playbookDecision: r.playbook_decision === null ? null : String(r.playbook_decision),
    });
  }
  return [...scopes.entries()].map(([scopeKey, channels]) => ({ scopeKey, channels: [...channels.values()].sort((a, b) => a.channel.localeCompare(b.channel)) }));
}

/** Opens the owner issues and the channel hand-offs for one company. */
export async function runGrowthReview(env: Env, companyId: string): Promise<GrowthReviewResult> {
  const now = env.now();
  const week = weekKey(now);
  const prefix = `${ORIGIN_ID.growthReview}${companyId}:${week}:`;
  const found = (await env.ctx.issues.list({ companyId, originKind: ORIGIN.growthReview as `plugin:${string}`, limit: 200 })) as unknown as Array<{ originId?: string | null }>;
  const done = new Set(found.map((i) => String(i.originId ?? "")).filter((id) => id.startsWith(prefix)));

  const roles = await currentRoles(env, companyId);
  const scopes = await readScopes(env, companyId, now);
  const company = await env.ctx.companies.get(companyId).catch(() => null);
  const href = linkFor("/cockpit", company?.issuePrefix ?? null);
  const weekLabel = mondayLabel(now);
  const noGoals = (await listGoals(env.ctx, companyId, ["active", "proposed"])).length === 0;
  const result: GrowthReviewResult = { opened: 0, existing: 0 };

  const open = async (originId: string, route: WorkRoute, content: { title: string; description: string }): Promise<void> => {
    if (done.has(originId)) {
      result.existing += 1;
      return;
    }
    await createWorkIssue(env.ctx, {
      companyId,
      title: content.title,
      description: content.description,
      priority: "medium",
      originKind: ORIGIN.growthReview as `plugin:${string}`,
      originId,
      ...(route.assigneeAgentId ? { assigneeAgentId: route.assigneeAgentId } : route.assigneeUserId ? { assigneeUserId: route.assigneeUserId } : {}),
      wakeReason: "Weekly growth review",
    });
    result.opened += 1;
  };

  // One issue per scope owner. Every scope goes to the Revenue Lead (a product scope has no owner the Cockpit can read), so today they share one issue.
  const owners = new Map<string, { route: WorkRoute; scopes: ReviewScope[] }>();
  const ownerRoute = routeFromRoles(roles, teamRoleChain("revenue-lead"));
  for (const scope of scopes) {
    const entry = owners.get(routeKey(ownerRoute)) ?? { route: ownerRoute, scopes: [] };
    entry.scopes.push(scope);
    owners.set(routeKey(ownerRoute), entry);
  }
  for (const [key, { route, scopes: owned }] of owners) {
    await open(`${prefix}owner:${key}`, route, growthReviewContent({ weekLabel, scopes: owned, proposeGoals: noGoals && owned.some((s) => s.scopeKey === "own"), cockpitHref: href }));
  }

  // One hand-off per channel agent, listing its channels and the scopes each runs in.
  const agents = new Map<string, { route: WorkRoute; channels: Map<string, string[]> }>();
  for (const scope of scopes) {
    for (const { channel } of scope.channels) {
      const route = routeFromRoles(roles, teamRoleChain(channelRole(channel)));
      const entry = agents.get(routeKey(route)) ?? { route, channels: new Map() };
      entry.channels.set(channel, [...(entry.channels.get(channel) ?? []), scope.scopeKey]);
      agents.set(routeKey(route), entry);
    }
  }
  for (const [key, { route, channels }] of agents) {
    await open(`${prefix}handoff:${key}`, route, growthHandoffContent({ weekLabel, channels: [...channels].map(([channel, scopeKeys]) => ({ channel, scopes: scopeKeys })) }));
  }
  return result;
}

/** Weekly job: every company with saved Cockpit settings. */
export async function growthReviews(env: Env): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  let tried = 0;
  for (const row of await listRoles(env.ctx)) {
    if (!(await configSaved(env.ctx, row.companyId))) continue;
    tried += 1;
    try {
      const r = await runGrowthReview(env, row.companyId);
      counts.opened = (counts.opened ?? 0) + r.opened;
      counts.existing = (counts.existing ?? 0) + r.existing;
    } catch (error) {
      counts.failed = (counts.failed ?? 0) + 1;
      env.ctx.logger.info("Growth review failed for a company", { companyId: row.companyId, error: message(error) });
    }
  }
  throwIfEveryCompanyFailed("The weekly growth review", tried, counts.failed ?? 0);
  return counts;
}
