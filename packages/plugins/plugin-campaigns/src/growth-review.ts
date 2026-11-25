/**
 * The Weekly review tab: a person reads the proposed experiments and playbook
 * changes of one program and approves or rejects them. The kit service does the
 * work and the issue comments; this file only builds the person as the actor
 * (autopilot `safe` and `reviewed` leave these decisions to a person).
 */
import type { PluginContext, PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import {
  approveExperiment,
  decidePlaybookChange,
  getPlaybookRecord,
  listExperimentsRecord,
  type GrowthActor,
} from "@partnersinbiz/pib-plugin-kit";
import { parseClientParam } from "@partnersinbiz/pib-plugin-kit/client-ref";
import { eventCounts, listCampaigns } from "./db.js";
import { CampaignError } from "./domain.js";
import { campaignsGrowthEnv, rejectCampaignExperiment } from "./growth-host.js";

type Params = Record<string, unknown>;

/** The signed-in person behind a page action. An agent never reaches these actions, and a call without a user is refused. */
function personActor(context: PluginPerformActionContext, what: string): GrowthActor {
  if (!context.companyId) throw new CampaignError("Company is required");
  const userId = context.actor.type === "user" && typeof context.actor.userId === "string" ? context.actor.userId.trim() : "";
  if (!userId) throw new CampaignError(`Sign in as a person to ${what}.`);
  return { companyId: context.companyId, userId, agentId: null, isAgent: false };
}

/** The program's experiments (a program with none yet is created empty, as the get-playbook tool does) (proposed, running and measured) and the playbook changes waiting for a decision. */
export async function growthReviewLoad(ctx: PluginContext, context: PluginPerformActionContext, params: Params) {
  const actor = personActor(context, "see the weekly review");
  const env = campaignsGrowthEnv(ctx);
  const scope = { client: params.client ?? null };
  const [experiments, playbook] = await Promise.all([
    listExperimentsRecord(env, actor, { ...scope, status: "proposed,running,measured" }),
    getPlaybookRecord(env, actor, scope),
  ]);
  return {
    programId: experiments.programId,
    client: experiments.client,
    // Emails sent so far by this scope's campaigns: an experiment has nothing to measure until the first one goes out. Null when it could not be counted.
    sent: await scopeSends(ctx, actor.companyId, typeof params.client === "string" ? params.client : null).catch(() => null),
    autopilot: playbook.autopilot,
    playbookVersion: playbook.playbookVersion,
    experiments: experiments.experiments,
    changes: playbook.pendingChanges,
  };
}

/** Emails sent by the campaigns of one scope (our own, or one client's). */
async function scopeSends(ctx: PluginContext, companyId: string, client: string | null): Promise<number> {
  const campaigns = await listCampaigns(ctx, companyId, parseClientParam(client));
  const ids = new Set(campaigns.map((campaign) => campaign.id));
  const counts = await eventCounts(ctx, companyId);
  return counts.filter((row) => row.event_type === "sent" && ids.has(row.campaign_id)).reduce((total, row) => total + Number(row.count ?? 0), 0);
}

export async function growthApproveExperiment(ctx: PluginContext, context: PluginPerformActionContext, params: Params) {
  return approveExperiment(campaignsGrowthEnv(ctx), personActor(context, "approve an experiment"), params);
}

export async function growthRejectExperiment(ctx: PluginContext, context: PluginPerformActionContext, params: Params) {
  return rejectCampaignExperiment(campaignsGrowthEnv(ctx), personActor(context, "reject an experiment"), params);
}

export async function growthDecideChange(ctx: PluginContext, context: PluginPerformActionContext, params: Params) {
  return decidePlaybookChange(campaignsGrowthEnv(ctx), personActor(context, "decide a playbook change"), params);
}
