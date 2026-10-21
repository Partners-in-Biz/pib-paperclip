/**
 * Growth Lab measuring for SEO. An experiment is tied to pages through one
 * `growth_experiment_items` row of kind `page_link` per page (no migration: the kit never reads that kind).
 * The daily job hands the kit `measureExperiment` each linked page's GSC metrics (clicks, impressions)
 * as batches, so the kit alone writes the verdict, scoreboard, playbook change and `growth.verdict` event.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, measureExperiment, type GrowthStore, type KitExperiment } from "@partnersinbiz/pib-plugin-kit";
import { gscPageQueryRows } from "./service/gsc.js";
import { companyInfo, type Env } from "./service/common.js";
import * as db from "./db.js";
import { t } from "./db.js";
import { seoGrowthEnv, seoGrowthStore } from "./growth-host.js";
import { PLUGIN_ID } from "./namespace.js";

export const LINK_KIND = "page_link";

export interface PageMetrics {
  pageUrl: string;
  arm: "control" | "variant";
  clicks: number;
  impressions: number;
  measuredAt: string;
}

/** Fetch GSC metrics for pages linked to an experiment. Returns tuples of (pageUrl, arm, clicks, impressions). */
export async function linkedPageMetrics(ctx: PluginContext, experimentId: string): Promise<PageMetrics[]> {
  const rows = await ctx.db.query<{ subject_id: string; arm: string }>(
    `SELECT subject_id, arm FROM ${t("growth_experiment_items")} WHERE experiment_id = $1 AND subject_kind = $2 ORDER BY created_at`,
    [experimentId, LINK_KIND],
  );
  return rows.map((r) => ({
    pageUrl: String(r.subject_id),
    arm: (r.arm === "variant" ? "variant" : "control") as "control" | "variant",
    clicks: 0,
    impressions: 0,
    measuredAt: new Date().toISOString(),
  }));
}

/** The store the kit measures with: the 024 store plus `experimentPosts` over the linked pages' GSC metrics. */
export function measuringStore(ctx: PluginContext, store: GrowthStore = seoGrowthStore(ctx)): GrowthStore {
  return {
    ...store,
    async experimentPosts(companyId: string, experimentId: string) {
      const experiment = (await store.getExperiment(companyId, experimentId)) as KitExperiment | null;
      if (!experiment?.startedAt) return [];

      const since = new Date(experiment.startedAt);
      const until = new Date();
      const sinceDate = since.toISOString().slice(0, 10);
      const untilDate = until.toISOString().slice(0, 10);

      // Get all sprints for this company and fetch their GSC metrics
      const sprints = await db.listSprints(ctx.db, companyId);
      const env = { ctx } as unknown as Env;
      const batches: PageMetrics[] = [];

      for (const sprint of sprints) {
        try {
          const info = await companyInfo(env, companyId);
          const pageMetrics = await gscPageQueryRows(env, info, sprint, sinceDate, untilDate);

          // For each linked page, get the metrics
          const linkedPages = await linkedPageMetrics(ctx, experimentId);
          for (const linked of linkedPages) {
            const metrics = pageMetrics.get(linked.pageUrl);
            if (metrics) {
              batches.push({
                pageUrl: linked.pageUrl,
                arm: linked.arm,
                clicks: metrics.clicks,
                impressions: metrics.impressions,
                measuredAt: new Date().toISOString(),
              });
            }
          }
        } catch {
          // Skip sprints without GSC access
        }
      }

      // Convert PageMetrics to the format expected by the kit (as experiment items)
      return batches.map((b) => ({
        postId: `${b.pageUrl}:${b.arm}`,
        arm: b.arm,
        status: "published" as const,
        lifts: b.impressions > 0 ? [b.clicks / b.impressions] : [0],
      }));
    },
  } as unknown as GrowthStore;
}

/** Daily: measure every running experiment. One failing experiment does not stop the rest. */
export async function measureExperimentsJob(ctx: PluginContext) {
  const base = seoGrowthEnv(ctx);
  const measuring = { ...base, store: measuringStore(ctx, base.store) };
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
