/**
 * Campaigns host for the kit Growth Lab: the store on the 015 tables, the scope
 * and approval-issue ports, the wording, and the eight tools' handlers. The kit
 * service runs the lifecycle; the channel stays `campaigns` through `env.channel`.
 * Own and client scopes only: 015 limits `client_kind` to company and contact.
 */
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  AUTOPILOT_MODES,
  createGrowthStore,
  decidePlaybookChange,
  getPlaybookRecord,
  isClientKind,
  isModuleEnabled,
  listExperimentsRecord,
  openApprovalIssue,
  programForParams,
  proposeExperiment,
  proposePlaybookChange,
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
import { CAMPAIGNS_CHANNEL, campaignsAdapter } from "./growth-adapter.js";
import { CampaignError } from "./domain.js";
import { table } from "./db.js";
import { GROWTH_TOOL_OPTIONS } from "./tools.js";
import { PLUGIN_ID } from "./namespace.js";
import { campaignsProjectId } from "./projects.js";

/** `growth_experiment_items.subject_kind` for Campaigns: the item is a campaign. */
export const SUBJECT_KIND = "campaign";
const OPEN_ISSUE = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);

export interface CampaignsGrowthEnv {
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

export function campaignsGrowthStore(ctx: PluginContext): GrowthStore {
  return createGrowthStore({
    db: ctx.db,
    table: (name) => table(ctx, name),
    subjectKind: SUBJECT_KIND,
    mapProgram: (p) => ({
      ...p,
      clientKind: p.clientRef ? (isClientKind(p.clientKind) ? p.clientKind : "company") : null,
      autopilot: AUTOPILOT_MODES.includes(p.autopilot as Autopilot) ? p.autopilot : "safe",
    }),
  }) as GrowthStore;
}

/** `client` / `clientKind`+`clientRef` to a CRM-checked scope. A client the CRM does not know is refused before any read or write. */
export function campaignsScopes(ctx: PluginContext): CampaignsGrowthEnv["scopes"] {
  return {
    async fromParams(companyId, params) {
      const scope = clientScopeFromInput(params);
      if (scope === undefined) {
        if (params.client === undefined || params.client === null) return { scope: null, client: null };
        throw new CampaignError("client must be company:<crm company id> or contact:<crm contact id>. Omit it for PiB's own work.");
      }
      if (!scope) return { scope: null, client: null };
      const client = await resolveCrmClient(ctx, ctx.db.namespace, companyId, scope);
      if (!client) throw new CampaignError(`CRM ${scope.kind} ${scope.id} was not found. Run the CRM "resync" action if it was just created.`);
      return { scope, client: { name: client.name } };
    },
    toParam: (scope) => (scope ? formatClientParam(scope) : "own"),
  };
}

export function campaignsApprovalIssues(ctx: PluginContext): ApprovalIssuePort {
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

const label = (p: Pick<KitProgram, "clientName" | "clientRef">) => (p.clientRef ? p.clientName ?? p.clientRef : "PiB's own campaigns");
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

export function verdictComment(e: Pick<KitExperiment, "hypothesis">, verdict: string, reason: string, diff: string | null, kept: boolean): string {
  const lines = [`**Experiment measured: ${verdict.replace("_", " ")}** — ${e.hypothesis}`, "", reason];
  if (diff) lines.push("", kept ? `Kept automatically (full autopilot): ${diff}` : `Proposed playbook change: ${diff}`);
  return lines.join("\n");
}

export function campaignsGrowthEnv(ctx: PluginContext, store: GrowthStore = campaignsGrowthStore(ctx)): CampaignsGrowthEnv {
  return {
    ctx,
    store,
    now: () => new Date(),
    channel: CAMPAIGNS_CHANNEL,
    objective: campaignsAdapter.defaultObjective,
    metric: campaignsAdapter.defaultMetric,
    scopes: campaignsScopes(ctx),
    issuePort: () => campaignsApprovalIssues(ctx),
    timezone: () => "UTC",
    starterPlaybook: (target: { scope: ClientScope; name: string | null }) =>
      starterPlaybook(`${target.scope ? target.name ?? target.scope.id : "PiB"} campaigns`).replace("(what we optimise, in one sentence)", campaignsAdapter.defaultObjective),
    programOut,
    experimentOut,
    changeOut,
    actorLabel: (a: GrowthActor) => (a.isAgent ? "the Campaigns agent" : "a person"),
    verdictComment,
    experimentLines: (e: KitExperiment) => [
      `### Experiment: ${e.hypothesis}`,
      `- Tests \`${e.hypothesisType}\` (${e.variable}) · ${armsLine(e)}`,
      `- Needs ${e.minPerArm}+ sends per variant on a step; the reply rate of each step is compared over 7 days.`,
      `- experimentId: \`${e.id}\``,
      "",
    ],
    changeLines: (c: KitChange) => [`### Playbook change: ${c.diff}`, `- Why: ${c.reason}`, `- changeId: \`${c.id}\``, ""],
    async buildApprovalInput(program: KitProgram, week: string, lines: string[]) {
      return {
        companyId: program.companyId,
        title: `${program.clientRef ? `[${label(program)}] ` : ""}Approve campaign experiments and playbook changes (${week})`.slice(0, 250),
        description: [
          `The Campaigns agent's weekly review for **${label(program)}** has items for you. Experiments change one thing at a time on real campaign steps; playbook changes edit the rules the agent follows when it writes campaigns.`,
          "",
          ...lines,
          `Autopilot: **${program.autopilot}** (off: agents only read; safe: a person approves; reviewed: the Reviewer decides what stays internal; full: the agent approves and wins are kept automatically).`,
        ].join("\n"),
        priority: "medium",
        originKind: `plugin:${PLUGIN_ID}`,
        originId: `growth:${program.id}:${week}`,
        projectId: (await campaignsProjectId(ctx, program.companyId)) ?? undefined,
        outward: false,
        actorUserId: program.ownerUserId,
      };
    },
  } as CampaignsGrowthEnv;
}

/** Hypothesis types, ranked, and what is open: the part of a review that needs no step data. Step reply rates come from `measureCampaign`. */
export async function performanceReview(env: CampaignsGrowthEnv, actor: GrowthActor, params: Record<string, unknown>) {
  const program = (await programForParams(env, actor, params)) as KitProgram;
  const [open, pending] = await Promise.all([
    env.store.listExperiments(actor.companyId, program.id, OPEN_EXPERIMENTS) as Promise<KitExperiment[]>,
    env.store.listChanges(actor.companyId, program.id, "pending") as Promise<KitChange[]>,
  ]);
  const topics = Array.isArray(program.constraints.topics) ? (program.constraints.topics as string[]) : [];
  return {
    program: programOut(program),
    runningExperiments: open.filter((e) => e.status === "running").map((e) => experimentOut(e)),
    proposedExperiments: open.filter((e) => e.status === "proposed").map((e) => experimentOut(e)),
    pendingChanges: pending.map(changeOut),
    rankedHypothesisTypes: rankedHypotheses({ topics, featureQuestions: [], scoreboard: program.scoreboard }, { running: open.map((e) => e.hypothesisType), lifts: [] }, 12),
    notes: ["Reply rates per step are measured by the daily measure-experiments job, 7 days after each send, and only once both variants have 30 sends."],
  };
}

/** Campaigns tags no posts, so the kit's reject has nothing to untag (it assumes the store lists tagged posts and fails without it). */
export const withoutPostTags = (env: CampaignsGrowthEnv): CampaignsGrowthEnv => ({ ...env, store: { ...env.store, experimentPosts: async () => [] } as GrowthStore });

/** The eight handlers over one env per call (tests pass an env with a fixed scope resolver). */
export function campaignsGrowthHandlers(envFor: () => CampaignsGrowthEnv): GrowthToolsHost<GrowthActor>["handlers"] {
  const run = (fn: (env: CampaignsGrowthEnv, actor: GrowthActor, p: Record<string, unknown>) => Promise<unknown>) => (actor: GrowthActor, p: Record<string, unknown>) => fn(envFor(), actor, p);
  return {
    "performance-review": run(performanceReview),
    "get-playbook": run(getPlaybookRecord),
    "propose-playbook-change": run(proposePlaybookChange),
    "decide-playbook-change": run(decidePlaybookChange),
    "list-experiments": run(listExperimentsRecord),
    "propose-experiment": run(proposeExperiment),
    "approve-experiment": run(approveExperiment),
    "reject-experiment": run((env, actor, p) => rejectExperiment(withoutPostTags(env), actor, p)),
  };
}

/** The kit's eight tools, run for Campaigns: the module switch, the caller and the kit service. Agent decisions on `reviewed` need the Reviewer role. */
export function campaignsGrowthToolsHost(ctx: PluginContext): GrowthToolsHost<GrowthActor> {
  return {
    ...GROWTH_TOOL_OPTIONS,
    async actor(runContext: ToolRunContext) {
      if (!(await isModuleEnabled(ctx, runContext.companyId, PLUGIN_ID))) throw new CampaignError("Campaigns is switched off for this company.");
      const agentId = runContext.agentId ?? null;
      const reviewer = agentId ? (await reviewerAgentId(ctx, runContext.companyId)) === agentId : false;
      return { companyId: runContext.companyId, userId: null, agentId, isAgent: Boolean(agentId), isReviewer: reviewer };
    },
    handlers: campaignsGrowthHandlers(() => campaignsGrowthEnv(ctx)),
  };
}
