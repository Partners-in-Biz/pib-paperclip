/**
 * The checks the Cockpit adds to its own snapshot beyond the operations watch
 * (`watch.ts`): the kit's drift, grant, approval and run-profile checks, the
 * measurement alerts, the registers and confirmations, and what waits on the
 * owner. Each runs on its own: one that cannot read its data says nothing
 * (and logs) instead of failing the snapshot, and the whole set is cached for
 * ten minutes per company because the snapshot is read on every page load.
 *
 * Findings: Q9-8 / Q9-13 (role drift, run profile), RC5 (unrouted approvals,
 * blocked, grants), Q8-3 / Q8-8 / Q9-12 (measurement), Q1b-14 (client effort),
 * Q2-3 (improvements), Q10-3 (goals), and the critic's registers, custody and
 * backlog items.
 */
import {
  agentsWithoutPluginTools,
  backlogWaitingItems,
  dbBlockedByLookup,
  blockersUnreadableCheck,
  isModuleEnabled,
  MEMORY_GRANT_EFFECT_KEY,
  MODULES,
  pluginToolsGrantCheck,
  rolesCopyHealth,
  roleDriftCheck,
  skillSyncCheck,
  toolsGrantWaitingItem,
  unpinnedRunProfileCheck,
  unroutedApprovalsCheck,
  waitingBacklog,
  type CockpitKpi,
  type HealthCheck,
  type ModuleKey,
  type QualityMetric,
  type WaitingItem,
} from "@partnersinbiz/pib-plugin-kit";
import { acceptanceChecks } from "./acceptance.js";
import { backlogCheck, unhandledAsksCheck, type BacklogItem, type UnhandledAsk } from "./backlog-model.js";
import { clientEffortHealth } from "./client-cost.js";
import { credentialHealth } from "./credentials.js";
import { getRoles } from "./db.js";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { effectWaitingItems, listOpenAsks } from "./asks.js";
import { grantAskedRecently } from "./effects.js";
import { goalViews } from "./goals.js";
import { improvementsBrief } from "./improvements.js";
import { measureReviewCoverage, readLimitFailures, readSpendWindows, spendCaps, agentNames } from "./measure.js";
import { formatUsd, limitFailureChecks, reviewCoverageCheck, spendChecks } from "./measure-model.js";
import { memoryStats } from "./memory/store.js";
import { feedbackSignal } from "./memory/signal.js";
import { NAMESPACE } from "./namespace.js";
import { proofGapCheck, unreviewedApprovalCheck } from "./quality.js";
import { currentRoles } from "./roles.js";
import { attestationChecks, attestationState, membersCheck, readAttestations } from "./security.js";

export interface ExtraChecks {
  health: HealthCheck[];
  kpis: CockpitKpi[];
  quality: QualityMetric[];
  waiting: WaitingItem[];
}

const TTL_MS = 10 * 60_000;
const caches = new WeakMap<object, Map<string, { at: number; value: ExtraChecks }>>();

/** The modules the company has switched on, as the kit's role drift check wants them. */
async function moduleMap(env: Env, companyId: string): Promise<Partial<Record<ModuleKey, boolean>>> {
  const out: Partial<Record<ModuleKey, boolean>> = {};
  for (const key of Object.keys(MODULES) as ModuleKey[]) {
    let on = false;
    for (const plugin of MODULES[key].plugins) if (await isModuleEnabled(env.ctx, companyId, plugin)) on = true;
    out[key] = on;
  }
  return out;
}

type Part = () => Promise<Partial<ExtraChecks>>;

/** Runs the parts one after another (each may fail alone), merging what they return. */
async function gather(env: Env, companyId: string, parts: Array<[string, Part]>): Promise<ExtraChecks> {
  const out: ExtraChecks = { health: [], kpis: [], quality: [], waiting: [] };
  for (const [name, run] of parts) {
    try {
      const got = await run();
      out.health.push(...(got.health ?? []));
      out.kpis.push(...(got.kpis ?? []));
      out.quality.push(...(got.quality ?? []));
      out.waiting.push(...(got.waiting ?? []));
    } catch (error) {
      env.ctx.logger.info("Cockpit check failed", { companyId, check: name, error: message(error) });
    }
  }
  return out;
}

const nonOk = (check: HealthCheck | null | undefined): HealthCheck[] => (check && check.status !== "ok" ? [check] : []);

/** Whether a Cockpit question with this effect is open (the Needs-you list then already shows it). */
async function openCockpitAsk(env: Env, companyId: string, effectKey: string): Promise<boolean> {
  const rows = await env.ctx.db.query<Record<string, unknown>>(`SELECT id FROM ${NAMESPACE}.asks WHERE company_id = $1 AND source = 'cockpit' AND status = 'open' AND effect ->> 'key' = $2 LIMIT 1`, [companyId, effectKey]);
  return rows.length > 0;
}

export async function extraChecks(env: Env, companyId: string, options: { fresh?: boolean } = {}): Promise<ExtraChecks> {
  let cache = caches.get(env);
  if (!cache) caches.set(env, (cache = new Map()));
  const now = env.now();
  const hit = cache.get(companyId);
  if (!options.fresh && hit && now.getTime() - hit.at < TTL_MS) return hit.value;
  const ctx = env.ctx;
  const company = await ctx.companies.get(companyId).catch(() => null);
  const prefix = company?.issuePrefix ?? null;
  const roles = await getRoles(ctx, companyId).catch(() => null);

  const parts: Array<[string, Part]> = [
    // Skills and tool access of the staffed agents, and agents with no model or timeout pinned (Q9-8, Q9-13, Q8-7).
    ["role-drift", async () => {
      const report = await roleDriftCheck(ctx, companyId, { roles: await currentRoles(env, companyId), modules: await moduleMap(env, companyId) });
      return { health: nonOk(report.check) };
    }],
    ["run-profile", async () => {
      const agents = (await ctx.agents.list({ companyId, limit: 200 })) as unknown as Array<Record<string, unknown>>;
      return { health: nonOk(unpinnedRunProfileCheck(agents.map((a) => ({ id: String(a.id), name: String(a.name ?? "Agent"), status: a.status == null ? null : String(a.status), adapterType: a.adapterType == null ? null : String(a.adapterType), adapterConfig: (a.adapterConfig as Record<string, unknown> | null) ?? null })))) };
    }],
    // Agents that cannot call the memory tools (Q9-6, Q8-12). The owner is asked once (effects.ts); the kit's Needs-you item stands in only until that question is open.
    ["grants", async () => {
      const check = await pluginToolsGrantCheck(ctx, companyId);
      if (!check) return {};
      const waiting: WaitingItem[] = [];
      if (!(await openCockpitAsk(env, companyId, MEMORY_GRANT_EFFECT_KEY))) {
        // Not for agents the Cockpit already asked the owner about: an answered "no" is a no for the cooldown, not a reason to list the same item again at once.
        const asked = await grantAskedRecently(env, companyId);
        const { problems } = await agentsWithoutPluginTools(ctx, companyId);
        const item = toolsGrantWaitingItem(problems.filter((p) => !asked.has(p.agentId)), { prefix });
        if (item) waiting.push(item);
      }
      return { health: [check], waiting };
    }],
    ["roles-copy", async () => ({ health: nonOk(await rolesCopyHealth(ctx, companyId)) })],
    ["approvals", async () => ({ health: nonOk(await unroutedApprovalsCheck(ctx, companyId, { now: now.getTime() })) })],
    // Outward approvals a person holds that the Reviewer never saw (Q5-6), and finished code with no review and no proof (Q5-4).
    ["review-routing", async () => ({ health: nonOk(await unreviewedApprovalCheck(env, companyId)) })],
    ["proof", async () => ({ health: nonOk(await proofGapCheck(env, companyId)) })],
    // The canary journeys: failing ones, and a nightly request nobody works (Q5-1).
    ["acceptance", async () => acceptanceChecks(env, companyId)],
    // Everything that waits on the owner without being in their queue: approvals nobody was assigned and blocked issues with no way out (RC5).
    ["backlog", async () => {
      const asks = await listOpenAsks(env, companyId, 200).catch(() => []);
      const backlog = await waitingBacklog(ctx, companyId, { askIssueIds: new Set(asks.map((a) => a.issueId)), now: now.getTime(), blockedBy: dbBlockedByLookup(ctx) });
      const items: BacklogItem[] = [
        ...asks.map((a): BacklogItem => ({ id: a.issueId, kind: "ask", since: a.askedAt })),
        ...backlog.unroutedApprovals.map((a): BacklogItem => ({ id: a.id, kind: "unrouted", since: a.createdAt })),
        ...backlog.blockedNoPath.map((b): BacklogItem => ({ id: b.id, kind: "blocked", since: b.blockedSince })),
      ];
      const owner = roles?.ownerUserId ?? null;
      if (owner) {
        const mine = await ctx.db.query<Record<string, unknown>>(
          `SELECT id::text AS id, updated_at FROM public.issues WHERE company_id = $1::uuid AND assignee_user_id = $2 AND hidden_at IS NULL AND status IN ('todo', 'in_progress', 'in_review', 'blocked') LIMIT 200`,
          [companyId, owner],
        );
        for (const r of mine) items.push({ id: String(r.id), kind: "issue", since: r.updated_at ? new Date(String(r.updated_at)).toISOString() : null });
      }
      const pending = ((await ctx.approvals.list({ companyId }).catch(() => [])) as unknown as Array<Record<string, unknown>>).filter((a) => String(a.status) === "pending");
      for (const a of pending) items.push({ id: `approval:${String(a.id)}`, kind: "approval", since: a.createdAt ? new Date(String(a.createdAt)).toISOString() : null });
      return {
        health: [...nonOk(backlogCheck(items, now)), ...nonOk(blockersUnreadableCheck(backlog.blockedUnknown))],
        waiting: [...backlogWaitingItems(backlog, { prefix }), ...(await effectWaitingItems(env, companyId))],
      };
    }],
    ["unhandled-asks", async () => {
      const day = 86_400_000;
      const rows = await ctx.db.query<Record<string, unknown>>(
        `SELECT a.issue_id, a.issue_identifier, a.asked_at FROM ${NAMESPACE}.asks a JOIN public.issues i ON i.id::text = a.issue_id AND i.company_id::text = a.company_id
          WHERE a.company_id = $1 AND a.status = 'open' AND a.asked_at < $2::timestamptz AND i.updated_at < $3::timestamptz ORDER BY a.asked_at LIMIT 50`,
        [companyId, new Date(now.getTime() - 3 * day).toISOString(), new Date(now.getTime() - 3 * day).toISOString()],
      );
      const asks: UnhandledAsk[] = rows.map((r) => ({ issueId: String(r.issue_id), identifier: r.issue_identifier == null ? null : String(r.issue_identifier), askedAt: new Date(String(r.asked_at)).toISOString() }));
      return { health: nonOk(unhandledAsksCheck(asks)) };
    }],
    ["skill-sync", async () => ({ health: nonOk(await skillSyncCheck(ctx, companyId, "Cockpit", now.getTime())) })],
    // The measurement layer (Q8-3, Q8-8, Q9-12).
    ["measure", async () => {
      const [spend, caps, limits, coverage, names] = await Promise.all([
        readSpendWindows(ctx, companyId, now),
        spendCaps(ctx, companyId),
        readLimitFailures(ctx, companyId, new Date(now.getTime() - 24 * 3_600_000).toISOString()),
        measureReviewCoverage(env, companyId, 30, roles?.reviewerAgentId ?? null),
        agentNames(env, companyId),
      ]);
      const kpis: CockpitKpi[] = [{ key: "ai_spend_7d", label: "AI spend, 7 days (notional)", value: formatUsd(spend.usd7d), raw: Math.round(spend.usd7d * 100) / 100, hint: `${formatUsd(spend.usd24h)} in the last day. Not billed: flat-plan tokens at list price.`, tone: "neutral", group: "delivery", href: "/cockpit" }];
      if (coverage && coverage.coverage !== null) {
        kpis.push({ key: "review_coverage", label: "Code work reviewed (30 days)", value: `${Math.round(coverage.coverage * 100)}%`, raw: Math.round(coverage.coverage * 100), hint: `${coverage.reviewed} of ${coverage.done} closed${coverage.latencyP50Hours !== null ? `; typical review ${coverage.latencyP50Hours} h` : ""}`, tone: coverage.coverage >= 0.7 ? "ok" : "warn", group: "delivery", href: "/cockpit" });
      }
      return {
        health: [...spendChecks(spend, caps), ...limitFailureChecks(limits, names, 24), ...(coverage ? nonOk(reviewCoverageCheck(coverage)) : [])],
        kpis,
      };
    }],
    ["client-effort", async () => ({ health: await clientEffortHealth(env, companyId) })],
    ["credentials", async () => ({ health: await credentialHealth(env, companyId) })],
    // What only the owner can confirm, and the single admin (the critic's custody items).
    ["custody", async () => {
      const attested = await readAttestations(ctx, companyId);
      // A confirmation that has lapsed (180 days) no longer excuses the single-admin warning.
      const members = await membersCheck(env, companyId, attestationState(attested.get("second_admin"), now) === "confirmed");
      return { health: [...attestationChecks(attested, now), ...nonOk(members)] };
    }],
    // Self-improvement and goals (Q2-3, Q10-3).
    ["improvements", async () => {
      const brief = await improvementsBrief(env, companyId);
      const health: HealthCheck[] = brief.overdue > 0
        ? [{ key: "improvements:overdue", title: `${brief.overdue} improvement${brief.overdue === 1 ? "" : "s"} past the re-check date`, status: "warn", detail: "A change was recorded with a number to move and a date to look again, and the date passed without a measurement: the Cockpit could not read the number, or nobody recorded it.", href: "/cockpit", fix: "Record the number (improvement-resolve with resultValue) or drop the improvement; the weekly retro lists them." }]
        : [];
      return { health, kpis: brief.open > 0 ? [{ key: "improvements_open", label: "Open improvements", value: String(brief.open), raw: brief.open, hint: brief.due ? `${brief.due} due for a re-check` : "None due yet", tone: brief.overdue > 0 ? "warn" : "neutral", group: "other", href: "/cockpit" }] : [] };
    }],
    ["goals", async () => {
      const views = await goalViews(env, companyId, ["active"]);
      if (views.length === 0) return {};
      const good = views.filter((v) => v.progress.state === "reached" || v.progress.state === "on_track").length;
      return { kpis: [{ key: "goals_on_track", label: "Goals on track", value: `${good} of ${views.length}`, raw: good, hint: views.filter((v) => v.progress.state === "no_data").length ? "Some goals have no number yet" : "Reached or at least 80% of the way", tone: good === views.length ? "ok" : "warn", group: "other", href: "/cockpit" }] };
    }],
    ["memory-signal", async () => {
      const stats = await memoryStats(ctx, companyId);
      const signal = feedbackSignal(stats.briefs30d.total, stats.feedback30d.briefsWithFeedback);
      return { quality: [{ key: "memory_feedback_signal", label: "Memory brief feedback coverage (30 days)", value: signal.level === "none" ? "No signal" : `${stats.feedback30d.briefsWithFeedback} of ${stats.briefs30d.total}`, raw: stats.feedback30d.briefsWithFeedback, tone: signal.level === "ok" ? "ok" : "warn" }] };
    }],
  ];
  const value = await gather(env, companyId, parts);
  cache.set(companyId, { at: now.getTime(), value });
  return value;
}

/** Forget a company's cached checks (after a change that should show at once). */
export function forgetChecks(env: Env, companyId: string): void {
  caches.get(env)?.delete(companyId);
}

