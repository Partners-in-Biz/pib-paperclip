/**
 * SEO channel adapter: configuration for the Growth Lab channel.
 * Fetches page-level clicks and impressions from GSC and returns them as
 * MetricInput for the kit scoring engine.
 */
import type {
  ChannelAdapter,
  MetricInput,
  MetricSource,
} from "@partnersinbiz/pib-plugin-kit";

/**
 * Hypothesis types for SEO growth experiments.
 * Reused from loop/hypotheses.ts (the SEO signal detectors).
 * See packages/plugins/plugin-seo/src/loop/hypotheses.ts for context.
 */
const SEO_HYPOTHESIS_TYPES = [
  "stuck_page:depth-faq",
  "stuck_page:internal-links",
  "lost_keyword:rebuild",
  "zero_impression:relaunch",
  "unindexed:fix",
  "stagnation:refresh",
  "misalignment:retarget",
  "orphan:cluster",
  "cwv:fix",
  "directory:reattempt",
];

export interface SeoAdapterDeps {
  /**
   * Fetch GSC page rows (page+query dimensions) for a scope within a date range.
   * Returns aggregated page metrics keyed by comparable URL.
   * scopeKey format: "own", "client:company:ref", "client:contact:ref", etc.
   */
  fetchRows: (scopeKey: string, startDate: string, endDate: string) => Promise<Map<string, { clicks: number; impressions: number }>>;
}

/**
 * Create an SEO channel adapter for the Growth Lab.
 * Uses 14-day measurement windows, 20 impressions minimum per arm.
 * Default metric is clicks.
 * Hypothesis types match SEO signal detectors.
 */
export function createSeoAdapter(deps: SeoAdapterDeps): ChannelAdapter {
  const { fetchRows } = deps;

  const seoMetricSource: MetricSource = {
    channel: "seo",
    async fetchMetrics({ scopeKey, sinceIso, untilIso }) {
      const startDate = sinceIso.slice(0, 10);
      const endDate = untilIso.slice(0, 10);

      const pageMetrics = await fetchRows(scopeKey, startDate, endDate);

      const results: MetricInput[] = [];
      for (const [pageUrl, metrics] of pageMetrics) {
        results.push({
          destinationId: pageUrl,
          subjectId: pageUrl,
          accountId: scopeKey, // Scope key as accountId to maintain scope isolation
          platform: "gsc",
          publishedAt: sinceIso, // Window start as publishedAt (required for kit scoring)
          clicks: metrics.clicks,
          impressions: metrics.impressions,
        });
      }

      return results;
    },
  };

  return {
    channel: "seo",
    defaultObjective: "Grow organic impressions and clicks through page optimizations over 14 days.",
    defaultMetric: "clicks",
    windowDays: 14,
    minPerArm: 20, // Minimum impressions per arm
    hypothesisCandidates: () => SEO_HYPOTHESIS_TYPES,
    source: seoMetricSource,
  };
}
