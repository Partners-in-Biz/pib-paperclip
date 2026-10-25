/**
 * Growth Lab host: Social's implementations of the kit growth ports.
 * Wires the kit environment with Social-specific issue tracking, scopes,
 * features storage, and configuration.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  starterPlaybook,
  type ApprovalIssuePort, type ClientScope, type ScopeResolver,
} from "@partnersinbiz/pib-plugin-kit";
import { formatClientParam, sameClient, scopeFromParams, scopeOfRow, type ResolvedScope } from "../clients.js";
import { loadSocialConfig, type SocialConfig } from "../config.js";
import { ORIGIN_KIND, personAssignee, projectIdFor, SOCIAL_ORIGINS } from "../issues.js";
import { socialOn } from "../modules.js";
import { socialPath } from "../oauth/flow.js";
import { ownSocialName } from "../preferences.js";
import { jevConfigFor } from "../triage.js";
import { approvalIssueDescription, approvalIssueTitle, changeLines, experimentLines, verdictComment } from "./copy.js";
import { socialApprovalIssues, socialScopes, type SocialApprovalIssuePort, type SocialScopeResolver } from "./ports.js";
import { sqlGrowthStore } from "./sql.js";
import type { Experiment, GrowthStore, PlaybookChange, Program } from "./store.js";
import { DEFAULT_OBJECTIVE } from "@partnersinbiz/pib-plugin-kit";

export interface GrowthEnv {
  ctx: PluginContext;
  store: GrowthStore;
  now: () => Date;
  fetchImpl?: typeof fetch;
  /** Ports the host can swap (tests, other plugins); default to Social's own. */
  issues?: SocialApprovalIssuePort;
  scopes?: SocialScopeResolver;
}

export function growthEnv(ctx: PluginContext, store: GrowthStore = sqlGrowthStore(ctx)): GrowthEnv {
  return { ctx, store, now: () => new Date() };
}

/** Who acts (the plugin Viewer fits). */
export interface GrowthActor {
  companyId: string;
  userId: string | null;
  agentId: string | null;
  isAgent: boolean;
}

function programScope(program: Pick<Program, "clientKind" | "clientRef">): ClientScope {
  return program.clientRef ? { kind: program.clientKind ?? "company", id: program.clientRef } : null;
}

function programCtx(program: Program) {
  return { topics: Array.isArray(program.constraints.topics) ? program.constraints.topics : [], featureQuestions: program.featureQuestions };
}

function actorId(a: GrowthActor): string {
  return a.isAgent ? `agent:${a.agentId ?? "unknown"}` : `user:${a.userId ?? "unknown"}`;
}

function actorLabel(a: GrowthActor): string {
  return a.isAgent ? "the Social agent" : "a person";
}

export function issuePort(env: GrowthEnv): SocialApprovalIssuePort {
  return env.issues ?? socialApprovalIssues(env.ctx);
}

export function programOut(program: Program) {
  const scope = programScope(program);
  return {
    programId: program.id,
    client: scope ? formatClientParam(scope) : null,
    clientName: program.clientRef ? program.clientName : null,
    objective: program.objective,
    metric: program.metric,
    autopilot: program.autopilot,
    topics: programCtx(program).topics,
    brandVoice: program.constraints.brandVoice ?? null,
    platforms: program.constraints.platforms ?? null,
    cadence: program.constraints.cadence ?? null,
    playbookVersion: program.playbookVersion,
    scoreboard: program.scoreboard,
    featureQuestions: program.featureQuestions,
    ownerUserId: program.ownerUserId,
  };
}

export function experimentOut(e: Experiment, counts?: any) {
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
    controlMedian: typeof outcome.controlMedian === "number" ? outcome.controlMedian : null,
    variantMedian: typeof outcome.variantMedian === "number" ? outcome.variantMedian : null,
    playbookDiff: e.playbookDiff,
    playbookDecision: e.playbookDecision,
    note: e.decisionNote,
    counts: counts ?? null,
    createdAt: e.createdAt,
  };
}

export function changeOut(c: PlaybookChange) {
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

/** Helper to wrap an env for the kit service functions. Base env with UTC timezone. */
function wrapKitEnv(env: GrowthEnv, ownName = "Your company"): any {
  return {
    ...env,
    issuePort: (companyId: string) => issuePort(env),
    starterPlaybook: (target: any) => {
      const title = target.scope ? `${target.name ?? target.scope.id} social` : `${ownName} social`;
      return starterPlaybook(title).replace("(what we optimise, in one sentence)", DEFAULT_OBJECTIVE);
    },
    programOut,
    experimentOut,
    changeOut,
    experimentLines,
    changeLines,
    actorLabel,
    timezone: () => "UTC",
    buildApprovalInput: async (program: any, week: string, lines: string[], scope: any) => {
      const config = await loadSocialConfig(env.ctx, program.companyId);
      return {
        companyId: program.companyId,
        projectId: await projectIdFor(env.ctx, program.companyId, scope),
        title: approvalIssueTitle(program, week),
        description: approvalIssueDescription(program, lines, await socialPath(env.ctx, program.companyId, { tab: "growth" }, scope), program.clientRef ? undefined : await ownSocialName(env.ctx, program.companyId)),
        priority: "medium",
        originKind: ORIGIN_KIND,
        originId: `${SOCIAL_ORIGINS.growth}${program.id}:${week}`,
        assigneeUserId: await personAssignee(env.ctx, program.companyId, program.ownerUserId),
        wake: false,
      };
    },
    socialScopes: (ctx: PluginContext) => socialScopes(ctx),
    scopes: env.scopes ?? socialScopes(env.ctx),
  };
}

/** Wrap env for kit functions that need the company's timezone. */
export async function wrapKitEnvWithConfig(env: GrowthEnv, companyId: string): Promise<any> {
  const config = await loadSocialConfig(env.ctx, companyId);
  const baseEnv = wrapKitEnv(env, await ownSocialName(env.ctx, companyId));
  return {
    ...baseEnv,
    timezone: () => config.timezone,
  };
}

/** Wrap env for measure functions that also need verdict comments. */
export function wrapKitEnvForMeasure(wrapped: any, comment: typeof verdictComment) {
  return {
    ...wrapped,
    verdictComment: comment,
  };
}

/**
 * Create the Social host env: the four ports plus kit lifecycle support.
 * Call with config for functions that need timezone (e.g., proposeExperiment, measureExperiment).
 * Call without config for ensureProgram (which is used in scoring loops).
 */
export function socialKitEnv(env: GrowthEnv, config?: SocialConfig, ownName?: string): any {
  if (config) {
    return {
      ...wrapKitEnv(env, ownName),
      timezone: () => config.timezone,
    };
  }
  return wrapKitEnv(env, ownName);
}
