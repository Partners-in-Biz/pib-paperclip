/**
 * Experiment tagging for `record-metric`: the arm lives on the item row (one per metric window), as Social
 * does for posts. The metric number itself stays one per company, channel, scope, metric and window.
 */
import { createGrowthStore, type GrowthStore, type GrowthStoreTypes } from "@partnersinbiz/pib-plugin-kit";
import type { Env } from "./env.js";
import { NAMESPACE } from "./namespace.js";

/** `growth_experiment_items.subject_kind` of a metric window. */
export const WINDOW_ITEM_KIND = "window";

/** The channels Cockpit measures itself. Social, SEO, Campaigns and Ads measure their own. */
export const COCKPIT_CHANNELS = ["website", "aso", "book", "revenue"] as const;

/** The channel a scope uses when a tool call names none. Revenue is always explicit. */
export function defaultChannelForScope(scopeKey: string): (typeof COCKPIT_CHANNELS)[number] {
  if (scopeKey.startsWith("product:")) return "aso";
  if (scopeKey.startsWith("book:")) return "book";
  return "website";
}

export class GrowthTagError extends Error {}

export interface MetricTag {
  /** null: clear the tag for this window. */
  experimentId: string | null;
  arm: string | null;
}

/** Both or neither; an empty experimentId (with no arm) clears. Throws GrowthTagError. */
export function parseTag(raw: Record<string, unknown>): MetricTag | null {
  const { experimentId, arm } = raw;
  if (experimentId === undefined && arm === undefined) return null;
  if (experimentId === undefined && arm !== undefined && arm !== "" && arm !== null) throw new GrowthTagError("arm needs an experimentId");
  if (experimentId === "" || experimentId === null) {
    if (arm !== undefined && arm !== "" && arm !== null) throw new GrowthTagError("arm needs an experimentId");
    return { experimentId: null, arm: null };
  }
  if (typeof experimentId !== "string" || !experimentId.trim()) throw new GrowthTagError("experimentId must be text");
  if (typeof arm !== "string" || !arm.trim()) throw new GrowthTagError("experimentId and arm go together: give both, or neither");
  return { experimentId: experimentId.trim().slice(0, 80), arm: arm.trim().slice(0, 40) };
}

export function windowItemStore(env: Env): GrowthStore<GrowthStoreTypes> {
  return createGrowthStore<GrowthStoreTypes>({ db: env.ctx.db, table: (name) => `${NAMESPACE}.${name}`, subjectKind: WINDOW_ITEM_KIND });
}

interface Exp {
  id: string;
  programId: string;
  status: string;
  metric: string;
  arms: Array<{ key: string }>;
}
interface Prog {
  channel: string;
  scopeKey: string;
}

/** Checks a tag against the experiment before anything is written. Same company, running, known arm, same metric, channel and scope. */
export async function checkTag(env: Env, companyId: string, tag: MetricTag & { experimentId: string; arm: string }, input: { channel: string; subject: string; metric: string }): Promise<void> {
  const store = windowItemStore(env);
  const experiment = (await store.getExperiment(companyId, tag.experimentId)) as Exp | null;
  if (!experiment) throw new GrowthTagError(`Experiment ${tag.experimentId} was not found`);
  if (experiment.status !== "running") throw new GrowthTagError(`That experiment is ${experiment.status}; only running experiments take metric windows`);
  if (!experiment.arms.some((a) => a.key === tag.arm)) throw new GrowthTagError(`arm must be one of ${experiment.arms.map((a) => a.key).join(", ")}`);
  if (experiment.metric !== input.metric) throw new GrowthTagError(`That experiment measures ${experiment.metric}, not ${input.metric}`);
  const program = (await store.getProgram(companyId, experiment.programId)) as Prog | null;
  if (!program) throw new GrowthTagError(`Experiment ${tag.experimentId} has no program`);
  if (program.channel !== input.channel) throw new GrowthTagError(`That experiment runs on ${program.channel}, not ${input.channel}`);
  if (program.scopeKey !== input.subject) throw new GrowthTagError(`That experiment belongs to ${program.scopeKey}, not ${input.subject}`);
}

/** Writes the item (or clears it). Run after `checkTag` and the metric write. */
export async function writeTag(env: Env, companyId: string, tag: MetricTag, input: { channel: string; subject: string; window: string }): Promise<void> {
  if (tag.experimentId && tag.arm) {
    await windowItemStore(env).upsertItem(tag.experimentId, tag.arm, input.window, null);
    return;
  }
  // Clear: this window's item in any experiment of this company, channel and scope.
  await env.ctx.db.execute(
    `DELETE FROM ${NAMESPACE}.growth_experiment_items i
     USING ${NAMESPACE}.growth_experiments e, ${NAMESPACE}.growth_programs p
     WHERE i.experiment_id = e.id AND e.program_id = p.id
       AND p.company_id = $1 AND p.channel = $2 AND p.scope_key = $3
       AND i.subject_kind = $4 AND i.subject_id = $5`,
    [companyId, input.channel, input.subject, WINDOW_ITEM_KIND, input.window],
  );
}
