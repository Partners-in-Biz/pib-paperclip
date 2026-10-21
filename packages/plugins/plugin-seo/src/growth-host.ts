/**
 * SEO host for the kit Growth Lab: the store on the 024 growth tables, the scope
 * and approval-issue ports, the wording, and the five non-playbook tools' handlers.
 * The kit service runs the lifecycle; the channel stays `seo` through `env.channel`.
 * Own and client scopes only: 024 limits `client_kind` to company and contact.
 * SEO's own get-playbook, propose-playbook-change, decide-playbook-change
 * remain on SEO's playbook tables (013) and continue to work on sprint playbooks.
 */
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  AUTOPILOT_MODES,
  createGrowthStore,
  isClientKind,
  isModuleEnabled,
  listExperimentsRecord,
  openApprovalIssue,
  proposeExperiment,
  approveExperiment,
  rejectExperiment,
  rankedHypotheses,
  resolveCrmClient,
  reviewerAgentId,
  starterPlaybook,
  clientScopeFromInput,
  formatClientParam,
  OPEN_EXPERIMENTS,
  type ApprovalIssuePort,
  type Autopilot,
  type ClientScope,
  type GrowthActor,
  type GrowthStore,
  type GrowthToolsHost,
  type KitChange,
  type KitExperiment,
  type KitProgram,
  type ScopeResolver,
} from "@partnersinbiz/pib-plugin-kit";
import { createSeoAdapter } from "./growth/adapter.js";
import { gscPageQueryRows } from "./service/gsc.js";
import * as db from "./db.js";
import { t } from "./db.js";
import { NAMESPACE } from "./namespace.js";
import { PLUGIN_ID } from "./namespace.js";
import { SeoError, type Env } from "./service/common.js";
import { companyInfo } from "./service/common.js";

/** `growth_experiment_items.subject_kind` for SEO: the item is a page. */
export const SUBJECT_KIND = "page";
const OPEN_ISSUE = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export interface SeoGrowthEnv {
  ctx: PluginContext;
  store: GrowthStore;
  now: () => Date;
  channel: string;
  objective: string;
  metric: string;
  scopes: ScopeResolver<Record<string, unknown>, { scope: ClientScope; client: { name: string } | null }>;
  issuePort: (companyId: string) => ApprovalIssuePort;
  [key: string]: unknown;
}

export function seoGrowthStore(ctx: PluginContext): GrowthStore {
  return createGrowthStore({
    db: ctx.db,
    table: (name) => t(name),
    subjectKind: SUBJECT_KIND,
    mapProgram: (p) => ({
      ...p,
      clientKind: p.clientRef ? (isClientKind(p.clientKind) ? p.clientKind : "company") : null,
      autopilot: AUTOPILOT_MODES.includes(p.autopilot as Autopilot) ? p.autopilot : "safe",
    }),
  }) as GrowthStore;
}

/** `client` / `clientKind`+`clientRef` to a CRM-checked scope. A client the CRM does not know is refused before any read or write. */
export function seoScopes(ctx: PluginContext): SeoGrowthEnv["scopes"] {
  return {
    async fromParams(companyId, params) {
      const scope = clientScopeFromInput(params);
      if (scope === undefined) {
        if (params.client === undefined || params.client === null) return { scope: null, client: null };
        throw new SeoError("client must be company:<crm company id> or contact:<crm contact id>. Omit it for PiB's own work.");
      }
      if (!scope) return { scope: null, client: null };
      const client = await resolveCrmClient(ctx, NAMESPACE, companyId, scope);
      if (!client) throw new SeoError(`CRM ${scope.kind} ${scope.id} was not found. Run the CRM "resync" action if it was just created.`);
      return { scope, client: { name: client.name } };
    },
    toParam: (scope) => (scope ? formatClientParam(scope) : "own"),
  };
}

export function seoApprovalIssues(ctx: PluginContext): ApprovalIssuePort {
  return {
    createApproval: async (input) => openApprovalIssue(ctx, input as Parameters<typeof openApprovalIssue>[1]),
    async isOpen(companyId, issueId) {
      try {
        const issue = await ctx.issues.get(issueId, companyId);
        return Boolean(issue && OPEN_ISSUE.has(String(issue.status)));
      } catch {
        return false;
      }
    },
    async setStatus(companyId, issueId, status) {
      await ctx.issues.update(issueId, { status }, companyId);
    },
    async comment(companyId, issueId, body) {
      await ctx.issues.createComment(issueId, body, companyId);
    },
  };
}

const label = (p: Pick<KitProgram, "clientName" | "clientRef">) => (p.clientRef ? p.clientName ?? p.clientRef : "PiB's own sites");
const armsLine = (e: Pick<KitExperiment, "arms">) => e.arms.map((a) => `${a.key}: ${a.description}`).join(" · ");

function programOut(p: KitProgram) {
  return {
    programId: p.id,
    client: p.clientRef ? `${p.clientKind ?? "company"}:${p.clientRef}` : null,
    clientName: p.clientRef ? p.clientName : null,
    objective: p.objective,
    metric: p.metric,
    autopilot: p.autopilot,
    playbookVersion: p.playbookVersion,
    scoreboard: p.scoreboard,
    ownerUserId: p.ownerUserId,
  };
}

function experimentOut(e: KitExperiment, counts?: unknown) {
  const outcome = e.outcome ?? {};
  return {
    experimentId: e.id,
    status: e.status,
    hypothesis: e.hypothesis,
    hypothesisType: e.hypothesisType,
    variable: e.variable,
    arms: e.arms,
    minPerArm: e.minPerArm,
    windowDays: e.windowDays,
    proposedBy: e.proposedBy,
    approvalIssueId: e.approvalIssueId,
    approvedAt: e.approvedAt,
    startedAt: e.startedAt,
    measureBy: e.measureAfter,
    measuredAt: e.measuredAt,
    verdict: e.verdict,
    reason: typeof outcome.reason === "string" ? outcome.reason : null,
    relativeChange: typeof outcome.relativeChange === "number" ? outcome.relativeChange : null,
    playbookDiff: e.playbookDiff,
    playbookDecision: e.playbookDecision,
    note: e.decisionNote,
    counts: counts ?? null,
    createdAt: e.createdAt,
  };
}

function changeOut(c: KitChange) {
  return {
    changeId: c.id,
    status: c.status,
    op: c.op,
    section: c.section,
    text: c.op === "replace" ? null : c.body,
    diff: c.diff,
    reason: c.reason,
    experimentId: c.experimentId,
    baseVersion: c.baseVersion,
    resultVersion: c.resultVersion,
    proposedBy: c.proposedBy,
    decidedBy: c.decidedBy,
    decidedAt: c.decidedAt,
    note: c.decisionNote,
    createdAt: c.createdAt,
  };
}

export async function performanceReview(env: SeoGrowthEnv, actor: GrowthActor, params: Record<string, unknown>) {
  const { scope } = await env.scopes.fromParams(actor.companyId, params);
  const scopeKey = env.scopes.toParam(scope);
  const programId = `${actor.companyId}:seo:${scopeKey}`;

  const program = (await env.store.getProgram(actor.companyId, programId)) as KitProgram | null;
  if (!program) {
    return {
      program: null,
      runningExperiments: [],
      proposedExperiments: [],
      pendingChanges: [],
      rankedHypothesisTypes: [],
      notes: ["No growth program found for this scope yet."],
    };
  }

  const [open, pending] = await Promise.all([
    env.store.listExperiments(actor.companyId, program.id, OPEN_EXPERIMENTS) as Promise<KitExperiment[]>,
    env.store.listChanges(actor.companyId, program.id, "pending") as Promise<KitChange[]>,
  ]);

  const topics: string[] = [];
  return {
    program: programOut(program),
    runningExperiments: open.filter((e) => e.status === "running").map((e) => experimentOut(e)),
    proposedExperiments: open.filter((e) => e.status === "proposed").map((e) => experimentOut(e)),
    pendingChanges: pending.map(changeOut),
    rankedHypothesisTypes: rankedHypotheses({ topics, featureQuestions: [], scoreboard: program.scoreboard }, { running: open.map((e) => e.hypothesisType), lifts: [] }, 12),
    notes: ["Metrics are measured from Google Search Console data over the experiment window. Minimum 20 impressions per arm for a verdict."],
  };
}

/** The five non-playbook handlers. The three playbook tools remain on SEO's native tables. */
export function seoGrowthHandlers(envFor: () => SeoGrowthEnv): Partial<GrowthToolsHost<GrowthActor>["handlers"]> {
  const run = (fn: (env: SeoGrowthEnv, actor: GrowthActor, p: Record<string, unknown>) => Promise<unknown>) => (actor: GrowthActor, p: Record<string, unknown>) => fn(envFor(), actor, p);
  return {
    "performance-review": run(performanceReview),
    "list-experiments": run(listExperimentsRecord),
    "propose-experiment": run(proposeExperiment),
    "approve-experiment": run(approveExperiment),
    "reject-experiment": run(rejectExperiment),
  } as unknown as GrowthToolsHost<GrowthActor>["handlers"];
}

export function seoGrowthEnv(ctx: PluginContext, store: GrowthStore = seoGrowthStore(ctx)): SeoGrowthEnv {
  // Adapter factory: created fresh for each env so fetchRows has proper closure
  const createAdapterForEnv = () =>
    createSeoAdapter({
      fetchRows: async (scopeKey: string, startDate: string, endDate: string) => {
        // Parse scopeKey into a ClientScope
        let scope: ClientScope | null = null;
        if (scopeKey !== "own") {
          const match = scopeKey.match(/^client:(\w+):(.+)$/);
          if (match) {
            scope = { kind: match[1] as "company" | "contact", id: match[2] };
          }
        }

        // Aggregate GSC data from all companies' sprints with this scope
        const results = new Map<string, { clicks: number; impressions: number }>();

        // Get all companies that have sprints
        const allCompanies = await ctx.db.query<{ company_id: string }>(
          `SELECT DISTINCT company_id FROM ${t("sprints")} ORDER BY company_id`,
        );

        for (const { company_id: companyId } of allCompanies) {
          const sprints = await db.listSprints(ctx.db, companyId, { scope });

          for (const sprint of sprints) {
            const env = { ctx } as unknown as Env;
            try {
              const info = await companyInfo(env, companyId);
              const pageMetrics = await gscPageQueryRows(env, info, sprint, startDate, endDate);
              for (const [url, metrics] of pageMetrics) {
                const existing = results.get(url) ?? { clicks: 0, impressions: 0 };
                results.set(url, { clicks: existing.clicks + metrics.clicks, impressions: existing.impressions + metrics.impressions });
              }
            } catch {
              // Skip companies/sprints without GSC access
            }
          }
        }

        return results;
      },
    });

  const adapter = createAdapterForEnv();

  return {
    ctx,
    store,
    now: () => new Date(),
    channel: "seo",
    objective: adapter.defaultObjective,
    metric: adapter.defaultMetric,
    scopes: seoScopes(ctx),
    issuePort: () => seoApprovalIssues(ctx),
    timezone: () => "UTC",
    starterPlaybook: (target: { scope: ClientScope; name: string | null }) =>
      starterPlaybook(`${target.scope ? target.name ?? target.scope.id : "PiB"} SEO`).replace("(what we optimise, in one sentence)", adapter.defaultObjective),
    programOut,
    experimentOut,
    actorLabel: (a: GrowthActor) => (a.isAgent ? "the SEO agent" : "a person"),
    experimentLines: (e: KitExperiment) => [
      `### Experiment: ${e.hypothesis}`,
      `- Tests \`${e.hypothesisType}\` (${e.variable}) · ${armsLine(e)}`,
      `- Needs ${e.minPerArm}+ impressions per variant on a page; the click metrics of each page over ${e.windowDays} days are compared.`,
      `- experimentId: \`${e.id}\``,
      "",
    ],
    changeLines: () => [],
    async buildApprovalInput(program: KitProgram, week: string, lines: string[]) {
      return {
        companyId: program.companyId,
        title: `${program.clientRef ? `[${label(program)}] ` : ""}Approve SEO growth experiments and playbook changes (${week})`.slice(0, 250),
        description: [
          `The SEO agent's weekly review for **${label(program)}** has items for you. Experiments change one thing at a time on real pages; playbook changes edit the rules the agent follows when it optimises pages.`,
          "",
          ...lines,
          `Autopilot: **${program.autopilot}** (off: agents only read; safe: a person approves; reviewed: the Reviewer decides what stays internal; full: the agent approves and wins are kept automatically).`,
        ].join("\n"),
        priority: "medium",
        originKind: `plugin:${PLUGIN_ID}`,
        originId: `growth:${program.id}:${week}`,
        outward: false,
        actorUserId: program.ownerUserId,
      };
    },
  } as SeoGrowthEnv;
}

/** The kit's five tools, run for SEO: the module switch, the caller and the kit service. Agent decisions on `reviewed` need the Reviewer role. */
export function seoGrowthToolsHost(ctx: PluginContext): GrowthToolsHost<GrowthActor> {
  const env = seoGrowthEnv(ctx);

  return {
    kinds: ["own", "client"],
    descriptions: {
      "performance-review": "Growth Lab review of one scope: running and proposed experiments, pending playbook changes and hypothesis types ranked by UCB. Omit scope for PiB's own sites. Never mix scopes.",
      "list-experiments": "Growth Lab experiments of one scope with arms, verdicts and the scoreboard. Omit scope for PiB's own sites. Never mix scopes.",
    },
    async actor(runContext: ToolRunContext) {
      if (!(await isModuleEnabled(ctx, runContext.companyId, PLUGIN_ID))) throw new SeoError("SEO is switched off for this company.");
      const agentId = runContext.agentId ?? null;
      const reviewer = agentId ? (await reviewerAgentId(ctx, runContext.companyId)) === agentId : false;
      return { companyId: runContext.companyId, userId: null, agentId, isAgent: Boolean(agentId), isReviewer: reviewer };
    },
    handlers: seoGrowthHandlers(() => env),
  } as unknown as GrowthToolsHost<GrowthActor>;
}
