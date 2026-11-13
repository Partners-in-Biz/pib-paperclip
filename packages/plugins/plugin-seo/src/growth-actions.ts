/**
 * Person actions for growth experiments (PAR-10100): list, approve, reject, abandon.
 * The kit service runs the lifecycle; these handlers only resolve the scope from the
 * sprint, check the module switch, and pass a person actor (the kit refuses agents
 * on autopilot `safe`). Kit errors are thrown unchanged so the UI shows their text.
 */
import {
  abandonExperiment,
  approveExperiment,
  formatClientParam,
  isModuleEnabled,
  listExperimentsRecord,
  MAX_RUNNING,
  programForParams,
  rejectExperiment,
  type GrowthActor,
} from "@partnersinbiz/pib-plugin-kit";
import { seoGrowthEnv } from "./growth-host.js";
import { PLUGIN_ID } from "./namespace.js";
import { SeoError, type Env } from "./service/common.js";
import { requireSprint } from "./service/context.js";
import { playbookSummary } from "./service/playbook.js";

type Params = Record<string, unknown>;
interface PersonUser {
  userId: string | null;
}

async function guardModule(e: Env, companyId: string): Promise<void> {
  if (!(await isModuleEnabled(e.ctx, companyId, PLUGIN_ID))) throw new SeoError("SEO is switched off for this company.");
}

const personActor = (companyId: string, user: PersonUser): GrowthActor => ({ companyId, userId: user.userId, agentId: null, isAgent: false, isReviewer: false });

/** One sprint's growth experiments: the program of its client (or own sites), newest 50, with the running count from the store. */
export async function growthExperiments(e: Env, companyId: string, user: PersonUser, params: Params) {
  await guardModule(e, companyId);
  const sprintId = typeof params.sprintId === "string" ? params.sprintId : "";
  if (!sprintId) throw new SeoError("sprintId is required");
  const sprint = await requireSprint(e, companyId, sprintId);
  if (!sprint.clientRef && sprint.legacyClientName?.trim()) {
    return { scope: "unlinked", legacyClientName: sprint.legacyClientName, experiments: [], running: 0, maxRunning: MAX_RUNNING, programId: null, autopilot: null, pendingPlaybookChanges: null };
  }
  const env = seoGrowthEnv(e.ctx, companyId);
  const actor = personActor(companyId, user);
  const client = sprint.clientRef ? formatClientParam({ kind: sprint.clientKind ?? "company", id: sprint.clientRef }) : null;
  const scopeParams = { client };
  const program = await programForParams(env, actor, scopeParams);
  const list = await listExperimentsRecord(env, actor, scopeParams);
  const running = (await env.store.listExperiments(companyId, list.programId, ["running"])).length;
  const pending = (await playbookSummary(e, sprint)).pending;
  return {
    scope: sprint.clientRef ? "client" : "own",
    clientName: sprint.clientRef ? sprint.clientName : null,
    programId: list.programId,
    autopilot: program.autopilot,
    maxRunning: MAX_RUNNING,
    running,
    experiments: list.experiments,
    pendingPlaybookChanges: pending,
  };
}

export async function growthApprove(e: Env, companyId: string, user: PersonUser, params: Params) {
  await guardModule(e, companyId);
  return approveExperiment(seoGrowthEnv(e.ctx, companyId), personActor(companyId, user), params);
}

export async function growthReject(e: Env, companyId: string, user: PersonUser, params: Params) {
  await guardModule(e, companyId);
  return rejectExperiment(seoGrowthEnv(e.ctx, companyId), personActor(companyId, user), params);
}

export async function growthAbandon(e: Env, companyId: string, user: PersonUser, params: Params) {
  await guardModule(e, companyId);
  return abandonExperiment(seoGrowthEnv(e.ctx, companyId), personActor(companyId, user), params);
}
