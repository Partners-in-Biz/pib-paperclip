/**
 * Growth Lab measuring for Campaigns. An experiment is tied to a campaign through one
 * `growth_experiment_items` row of kind `campaign_link` (no migration: the kit never reads that kind). The daily job hands the kit
 * `measureExperiment` the campaign's sends as batches of `BATCH` per step and variant (A is the control, B the variant),
 * each batch's reply rate as its score, so the kit alone writes the verdict, scoreboard, playbook change and `growth.verdict` event.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, measureExperiment, type GrowthStore, type KitExperiment, type KitProgram } from "@partnersinbiz/pib-plugin-kit";
import { getCampaign, table } from "./db.js";
import { CampaignError } from "./domain.js";
import { BATCH, readStepEvents, WINDOW_DAYS, type StepEvent } from "./growth-adapter.js";
import { campaignsGrowthEnv, campaignsGrowthStore, type CampaignsGrowthEnv } from "./growth-host.js";
import { PLUGIN_ID } from "./namespace.js";

export const LINK_KIND = "campaign_link";
const DAY_MS = 86_400_000;
const LINKABLE = ["proposed", "running"];

export interface CampaignBatch {
  postId: string;
  arm: "control" | "variant";
  status: "published";
  lifts: number[];
}

/** Sends become batches only once the reply window has closed on every send in the batch; the batch's reply rate is its one score. */
export function campaignBatches(events: StepEvent[], campaignId: string, since: Date, now: Date): CampaignBatch[] {
  const closed = now.getTime() - WINDOW_DAYS * DAY_MS;
  const replied = new Set(events.filter((e) => e.eventType === "reply").map((e) => `${e.enrollmentId}:${e.stepPosition}`));
  const groups = new Map<string, boolean[]>();
  const sent = events.filter((e) => e.eventType === "sent" && Date.parse(e.occurredAt) >= since.getTime() && Date.parse(e.occurredAt) <= closed);
  for (const e of sent.sort((x, y) => Date.parse(x.occurredAt) - Date.parse(y.occurredAt))) {
    const key = `${e.stepPosition}:${e.variant === "b" ? "b" : "a"}`;
    groups.set(key, [...(groups.get(key) ?? []), replied.has(`${e.enrollmentId}:${e.stepPosition}`)]);
  }
  const out: CampaignBatch[] = [];
  for (const [key, sends] of groups) {
    for (let i = 0; i + BATCH <= sends.length; i += BATCH) {
      out.push({
        postId: `${campaignId}:${key}:${i / BATCH}`,
        arm: key.endsWith(":b") ? "variant" : "control",
        status: "published",
        lifts: [sends.slice(i, i + BATCH).filter(Boolean).length / BATCH],
      });
    }
  }
  return out;
}

/** Ties a campaign to an experiment of the same company and the same client scope. Refuses anything else before a row is written. */
export async function linkCampaignToExperiment(ctx: PluginContext, store: GrowthStore, companyId: string, experimentId: string, campaignId: string): Promise<void> {
  const experiment = (await store.getExperiment(companyId, experimentId)) as KitExperiment | null;
  if (!experiment) throw new CampaignError(`Experiment ${experimentId} was not found.`);
  if (!LINKABLE.includes(experiment.status)) throw new CampaignError(`Experiment ${experimentId} is ${experiment.status}; only a proposed or running one takes a campaign.`);
  const program = (await store.getProgram(companyId, experiment.programId)) as KitProgram | null;
  const campaign = await getCampaign(ctx, campaignId);
  if (!program || !campaign || campaign.companyId !== companyId) throw new CampaignError("Campaign or program was not found.");
  if ((program.clientRef ?? null) !== (campaign.clientRef ?? null) || (program.clientRef && (program.clientKind ?? "company") !== (campaign.clientKind ?? "company"))) {
    throw new CampaignError("The experiment belongs to another client's program than this campaign.");
  }
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "growth_experiment_items")} (experiment_id, arm, subject_kind, subject_id) VALUES ($1, 'link', $2, $3) ON CONFLICT DO NOTHING`,
    [experimentId, LINK_KIND, campaignId],
  );
}

/** The campaign ids tied to one experiment. */
export async function linkedCampaigns(ctx: PluginContext, experimentId: string): Promise<string[]> {
  const rows = await ctx.db.query<{ subject_id: string }>(`SELECT subject_id FROM ${table(ctx, "growth_experiment_items")} WHERE experiment_id = $1 AND subject_kind = $2 ORDER BY created_at`, [experimentId, LINK_KIND]);
  return rows.map((r) => String(r.subject_id));
}

/** The store the kit measures with: the 015 store plus `experimentPosts` over the linked campaigns' sends. */
export function measuringStore(ctx: PluginContext, store: GrowthStore = campaignsGrowthStore(ctx), now: () => Date = () => new Date()): GrowthStore {
  return {
    ...store,
    async experimentPosts(companyId: string, experimentId: string) {
      const experiment = (await store.getExperiment(companyId, experimentId)) as KitExperiment | null;
      if (!experiment?.startedAt) return [];
      const since = new Date(experiment.startedAt);
      const batches: CampaignBatch[] = [];
      for (const campaignId of await linkedCampaigns(ctx, experimentId)) {
        const campaign = await getCampaign(ctx, campaignId);
        if (!campaign || campaign.companyId !== companyId) continue;
        batches.push(...campaignBatches(await readStepEvents(ctx, companyId, campaignId, since.toISOString()), campaignId, since, now()));
      }
      return batches;
    },
  } as unknown as GrowthStore;
}

/** Daily: measure every running experiment that has a linked campaign. One failing experiment does not stop the rest. */
export async function measureExperimentsJob(ctx: PluginContext, env?: CampaignsGrowthEnv) {
  const base = env ?? campaignsGrowthEnv(ctx);
  const measuring: CampaignsGrowthEnv = { ...base, store: measuringStore(ctx, base.store, base.now) };
  const summary = { experiments: 0, measured: 0, waiting: 0, errors: 0 };
  for (const companyId of await base.store.companiesWithRunningExperiments()) {
    if (!(await isModuleEnabled(ctx, companyId, PLUGIN_ID))) continue;
    for (const e of (await base.store.runningExperiments(companyId)) as KitExperiment[]) {
      summary.experiments += 1;
      try {
        const result = await measureExperiment(measuring, e);
        if (result === "measured") summary.measured += 1;
        else if (result === "waiting") summary.waiting += 1;
      } catch (error) {
        summary.errors += 1;
        ctx.logger.info("Growth measurement failed", { experimentId: e.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return summary;
}
