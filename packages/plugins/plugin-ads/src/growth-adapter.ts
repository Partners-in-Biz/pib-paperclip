/**
 * Ads channel adapter for the Growth Lab: CPA lift per ad versus campaign median
 * from `ad_daily`, judged with the kit `experimentVerdict`. Each arm is a set of
 * ad_external_ids in one campaign; metric is cost per conversion relative to peers.
 */
import {
  experimentVerdict,
  hypothesisCandidates as kitHypothesisCandidates,
  median,
  type ChannelAdapter,
  type MetricSource,
  type ProgramFeatureContext,
  type Verdict,
} from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { addDays } from "./dates.js";
import { table } from "./db.js";
import { toNum } from "./money.js";
import { computeWinner, type AdDailyRow, DEFAULT_VARIANT_CONFIG, type VariantConfig } from "./variants.js";

export const ADS_CHANNEL = "ads";
/** Minimum impressions per ad before it qualifies for analysis. */
export const MIN_IMPRESSIONS_PER_ARM = DEFAULT_VARIANT_CONFIG.minImpressions;
/** Minimum conversions per ad before it qualifies for analysis; the second qualification gate. */
export const MIN_CONVERSIONS_PER_ARM = DEFAULT_VARIANT_CONFIG.minConversions;
export const WINDOW_DAYS = DEFAULT_VARIANT_CONFIG.windowDays;
/** Row cap of one read; a campaign that reaches it is flagged `truncated`. */
export const MAX_ROWS = 50_000;

export interface AdCpa {
  adId: string;
  impressions: number;
  conversions: number;
  spendMinor: number;
  cpaMinor: number | null;
  qualified: boolean;
  cpaIndex: number | null;
  cpaLift: number | null;
  campaignWinner: boolean;
}

export interface ArmSpec {
  control: string[];
  variant: string[];
}

export interface ArmSummary {
  ads: number;
  qualified: number;
  medianCpaLift: number | null;
}

export interface AdsGrowthResult {
  verdict: Verdict;
  winner: "control" | "variant" | null;
  campaignMedianCpaMinor: number | null;
  ads: AdCpa[];
  control: ArmSummary;
  variant: ArmSummary;
  relativeChange: number | null;
  beatShare: number | null;
  reason: string;
}

/**
 * Summarise one campaign's ads: compute CPA, campaign median, and CPA index for each ad.
 * Pure function; rows are ONE campaign's ad_daily rows. One AdCpa per distinct ad_external_id, sorted by adId.
 * Window = [today-windowDays+1, today]; zero-conversion ads are never qualified and have cpaMinor null.
 */
export function summariseAds(rows: AdDailyRow[], opts: { today: string; config?: VariantConfig }): { ads: AdCpa[]; medianCpaMinor: number | null } {
  const config = opts.config ?? DEFAULT_VARIANT_CONFIG;
  const today = opts.today;

  const windowStart = addDays(today, -config.windowDays + 1);

  // Collapse all rows to one row per (ad_external_id, day) by summing metrics
  // This prevents O(n²) behavior in computeWinner when called per ad
  const collapsedKey = (r: AdDailyRow) => `${r.ad_external_id}:${r.day}`;
  const collapsedRowsMap = new Map<string, AdDailyRow>();

  for (const r of rows) {
    const key = collapsedKey(r);
    const existing = collapsedRowsMap.get(key);
    if (existing) {
      existing.spend_minor += r.spend_minor;
      existing.impressions += r.impressions;
      existing.clicks += r.clicks;
      existing.conversions = toNum(existing.conversions) + toNum(r.conversions);
      existing.frequency = Math.max(existing.frequency, r.frequency);
    } else {
      collapsedRowsMap.set(key, { ...r });
    }
  }

  const collapsedRows = Array.from(collapsedRowsMap.values());

  // Group collapsed rows by ad_external_id (for all rows and window-filtered rows)
  const byAdAll = new Map<string, AdDailyRow[]>();
  const byAd = new Map<string, AdDailyRow[]>();

  for (const r of collapsedRows) {
    const list = byAdAll.get(r.ad_external_id) ?? [];
    list.push(r);
    byAdAll.set(r.ad_external_id, list);

    if (r.day >= windowStart && r.day <= today) {
      const windowList = byAd.get(r.ad_external_id) ?? [];
      windowList.push(r);
      byAd.set(r.ad_external_id, windowList);
    }
  }

  // Compute per-ad metrics.
  const ads: AdCpa[] = [];
  const qualifiedCpas: number[] = [];

  for (const [adId, adRows] of byAd) {
    const impressions = adRows.reduce((sum, r) => sum + r.impressions, 0);
    const conversions = adRows.reduce((sum, r) => sum + toNum(r.conversions), 0);
    const spendMinor = adRows.reduce((sum, r) => sum + r.spend_minor, 0);
    const cpaMinor = conversions > 0 ? spendMinor / conversions : null;

    const qualified = impressions >= config.minImpressions && conversions >= config.minConversions;
    if (qualified && cpaMinor !== null) qualifiedCpas.push(cpaMinor);

    ads.push({ adId, impressions, conversions, spendMinor, cpaMinor, qualified, cpaIndex: null, cpaLift: null, campaignWinner: false });
  }

  const campaignMedianCpaMinor = median(qualifiedCpas);

  // Compute cpaIndex, cpaLift, and campaignWinner.
  for (const ad of ads) {
    if (ad.qualified && ad.cpaMinor !== null && campaignMedianCpaMinor !== null && campaignMedianCpaMinor > 0) {
      ad.cpaIndex = campaignMedianCpaMinor / ad.cpaMinor;
      ad.cpaLift = ad.cpaIndex - 1;
    }

    // Use computeWinner to determine if this ad is the campaign winner
    if (ad.qualified) {
      const adRowsAll = byAdAll.get(ad.adId) ?? [];
      if (computeWinner(adRowsAll, collapsedRows, config, today)) {
        ad.campaignWinner = true;
      }
    }
  }

  return { ads: ads.sort((a, b) => a.adId.localeCompare(b.adId)), medianCpaMinor: campaignMedianCpaMinor };
}

/**
 * Judge an ads experiment: compare CPA lift of control vs variant.
 * Pure function; reads all ads of the campaign, arms may overlap or be missing from rows.
 * Winner is "variant" when verdict "win", "control" when verdict "loss", else null.
 */
export function judgeAdsExperiment(rows: AdDailyRow[], arms: ArmSpec, opts: { today: string; config?: VariantConfig }): AdsGrowthResult {
  const config = opts.config ?? DEFAULT_VARIANT_CONFIG;
  const { ads, medianCpaMinor } = summariseAds(rows, { today: opts.today, config });

  // Extract qualified ads per arm.
  const controlAds = ads.filter((a) => arms.control.includes(a.adId) && a.qualified);
  const variantAds = ads.filter((a) => arms.variant.includes(a.adId) && a.qualified);

  // Check minimum per arm.
  if (controlAds.length < 1 || variantAds.length < 1) {
    const reason = `Needs ${config.minImpressions} impressions and ${config.minConversions} conversions per ad in each arm (control ${controlAds.length} of ${arms.control.length} ads qualify, variant ${variantAds.length} of ${arms.variant.length}).`;
    return {
      verdict: "inconclusive",
      winner: null,
      campaignMedianCpaMinor: medianCpaMinor,
      ads,
      control: { ads: arms.control.length, qualified: controlAds.length, medianCpaLift: null },
      variant: { ads: arms.variant.length, qualified: variantAds.length, medianCpaLift: null },
      relativeChange: null,
      beatShare: null,
      reason,
    };
  }

  // Pass cpaIndex (positive, >1 = cheaper) to experimentVerdict, not cpaLift (can be zero/negative).
  const controlIndexes = controlAds.map((a) => a.cpaIndex ?? 1);
  const variantIndexes = variantAds.map((a) => a.cpaIndex ?? 1);

  const v = experimentVerdict({ control: controlIndexes, variant: variantIndexes, minPerArm: 1 });

  const controlMedianCpaLift = median(controlAds.map((a) => a.cpaLift ?? 0));
  const variantMedianCpaLift = median(variantAds.map((a) => a.cpaLift ?? 0));

  return {
    verdict: v.verdict,
    winner: v.verdict === "win" ? "variant" : v.verdict === "loss" ? "control" : null,
    campaignMedianCpaMinor: medianCpaMinor,
    ads,
    control: { ads: arms.control.length, qualified: controlAds.length, medianCpaLift: controlMedianCpaLift },
    variant: { ads: arms.variant.length, qualified: variantAds.length, medianCpaLift: variantMedianCpaLift },
    relativeChange: v.relativeChange,
    beatShare: v.beatShare,
    reason: v.reason,
  };
}

/** SQL on the ad_daily table: one row per (account_id, campaign_external_id, ad_external_id, day), capped at MAX_ROWS. */
export async function readAdDaily(ctx: PluginContext, companyId: string, accountId: string, campaignExternalId: string, sinceDay: string): Promise<AdDailyRow[]> {
  const rows = await ctx.db.query<{
    account_id: string;
    campaign_external_id: string;
    ad_external_id: string;
    day: unknown;
    spend_minor: string | number;
    impressions: string | number;
    clicks: string | number;
    conversions: unknown;
    frequency: unknown;
  }>(
    `SELECT account_id, campaign_external_id, ad_external_id, day::text AS day, spend_minor, impressions, clicks, conversions, frequency
       FROM ${table(ctx, "ad_daily")}
      WHERE company_id = $1 AND account_id = $2 AND campaign_external_id = $3 AND day >= $4::date
      ORDER BY day, ad_external_id
      LIMIT ${MAX_ROWS}`,
    [companyId, accountId, campaignExternalId, sinceDay],
  );

  return rows.map((r) => ({
    account_id: String(r.account_id),
    campaign_external_id: String(r.campaign_external_id),
    ad_external_id: String(r.ad_external_id),
    day: String(r.day).slice(0, 10),
    spend_minor: Number(r.spend_minor),
    impressions: Number(r.impressions),
    clicks: Number(r.clicks),
    conversions: Number(r.conversions),
    frequency: Number(r.frequency),
  }));
}

/**
 * Measure one ads campaign experiment. Reads since today-(WINDOW_DAYS-1).
 * Today defaults to today in UTC. It only reads: it never writes (no winner_variant column in Ads).
 */
export async function measureAdsExperiment(
  ctx: PluginContext,
  companyId: string,
  accountId: string,
  campaignExternalId: string,
  arms: ArmSpec,
  opts: { today?: string } = {},
): Promise<AdsGrowthResult & { truncated: boolean }> {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const sinceDay = addDays(today, -(WINDOW_DAYS - 1));
  const rows = await readAdDaily(ctx, companyId, accountId, campaignExternalId, sinceDay);
  const truncated = rows.length >= MAX_ROWS;
  const result = judgeAdsExperiment(rows, arms, { today });
  return { ...result, truncated };
}

/** The metric rows come from `ad_daily` through `measureAdsExperiment`, so the generic source has nothing to fetch. */
const adsMetricSource: MetricSource = {
  channel: ADS_CHANNEL,
  async fetchMetrics() {
    return [];
  },
};

export const adsAdapter: ChannelAdapter = {
  channel: ADS_CHANNEL,
  defaultObjective: "Lower the cost per conversion of each ad against its campaign median, over 14 days.",
  defaultMetric: "CPA lift vs campaign median at 14d",
  minPerArm: MIN_IMPRESSIONS_PER_ARM,
  windowDays: WINDOW_DAYS,
  hypothesisCandidates: (program: ProgramFeatureContext) => kitHypothesisCandidates({ scoreboard: {}, ...program }),
  source: adsMetricSource,
};
