/**
 * Variant analytics: pure functions to compute winner and fatigue flags from ad-level daily data.
 * Defaults mirror the patterns in alerts.ts and match the config module.
 */
import { addDays } from "./dates.js";
import { toNum } from "./money.js";

export interface VariantConfig {
  minImpressions: number;
  minConversions: number;
  ctrDropPct: number;
  frequencyThreshold: number;
  windowDays: number;
  consecutiveDays: number;
}

export const DEFAULT_VARIANT_CONFIG: VariantConfig = {
  minImpressions: 1000,
  minConversions: 10,
  ctrDropPct: 20,
  frequencyThreshold: 3,
  windowDays: 14,
  consecutiveDays: 3,
};

export interface AdDailyRow {
  account_id: string;
  campaign_external_id: string;
  ad_external_id: string;
  day: string;
  spend_minor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  frequency: number;
}

export interface VariantRow {
  id: string;
  account_id: string;
  campaign_external_id: string;
  ad_external_id: string;
  label: string;
  axis_values: Record<string, unknown>;
  creative_ref: string | null;
}

export interface VariantWithFlags extends VariantRow {
  winner: boolean;
  fatigue: boolean;
}

/**
 * Compute CPA (cost per acquisition / conversion) for a group of daily rows.
 * Returns null if denominator is zero or the group is empty.
 */
function computeCpa(rows: AdDailyRow[]): number | null {
  if (rows.length === 0) return null;
  const spend = rows.reduce((sum, r) => sum + r.spend_minor, 0);
  const conversions = rows.reduce((sum, r) => sum + toNum(r.conversions), 0);
  if (conversions <= 0) return null;
  return spend / conversions;
}

/**
 * Check if an ad qualifies as a winner in its campaign.
 * Winner = lowest CPA among all qualifying ads in the same campaign over the window.
 * Qualifying = meets both min impressions and min conversions.
 * Only one winner per campaign; no winner if none qualifies.
 */
export function computeWinner(
  adDailyRows: AdDailyRow[],
  allAdsInCampaign: AdDailyRow[],
  config: VariantConfig,
  today: string,
): boolean {
  // Filter to the window
  const windowStart = addDays(today, -config.windowDays + 1);
  const windowRows = adDailyRows.filter((r) => r.day >= windowStart && r.day <= today);

  if (windowRows.length === 0) return false;

  // Check minimums
  const impressions = windowRows.reduce((sum, r) => sum + r.impressions, 0);
  const conversions = windowRows.reduce((sum, r) => sum + toNum(r.conversions), 0);

  if (impressions < config.minImpressions || conversions < config.minConversions) return false;

  // Find all qualifying ads in the campaign (same campaign_external_id)
  const campaignKey = `${windowRows[0]!.account_id}:${windowRows[0]!.campaign_external_id}`;
  const campaignAds = new Map<string, { cpa: number | null; conversions: number; id: string }>();

  for (const ad of allAdsInCampaign) {
    const adKey = `${ad.account_id}:${ad.campaign_external_id}:${ad.ad_external_id}`;
    if (
      ad.account_id === windowRows[0]!.account_id &&
      ad.campaign_external_id === windowRows[0]!.campaign_external_id
    ) {
      const adRowsInWindow = allAdsInCampaign.filter(
        (r) =>
          r.ad_external_id === ad.ad_external_id &&
          r.day >= windowStart &&
          r.day <= today,
      );

      const adImpressions = adRowsInWindow.reduce((sum, r) => sum + r.impressions, 0);
      const adConversions = adRowsInWindow.reduce((sum, r) => sum + toNum(r.conversions), 0);

      if (adImpressions >= config.minImpressions && adConversions >= config.minConversions) {
        const cpa = computeCpa(adRowsInWindow);
        campaignAds.set(adKey, { cpa, conversions: adConversions, id: ad.ad_external_id });
      }
    }
  }

  if (campaignAds.size === 0) return false;

  // Find the winner: lowest CPA, ties broken by higher conversions, then ad id
  const thisAdKey = `${windowRows[0]!.account_id}:${windowRows[0]!.campaign_external_id}:${windowRows[0]!.ad_external_id}`;
  const thisAd = campaignAds.get(thisAdKey);
  if (!thisAd) return false;

  let winner: { cpa: number | null; conversions: number; id: string } | null = null;

  for (const ad of campaignAds.values()) {
    if (winner === null) {
      winner = ad;
    } else if (ad.cpa === null && winner.cpa === null) {
      if (ad.conversions > winner.conversions || (ad.conversions === winner.conversions && ad.id > winner.id)) {
        winner = ad;
      }
    } else if (ad.cpa === null) {
      continue;
    } else if (winner.cpa === null) {
      winner = ad;
    } else if (ad.cpa < winner.cpa) {
      winner = ad;
    } else if (ad.cpa === winner.cpa) {
      if (ad.conversions > winner.conversions || (ad.conversions === winner.conversions && ad.id > winner.id)) {
        winner = ad;
      }
    }
  }

  return !!(winner && winner.id === thisAd.id);
}

/**
 * Check if an ad shows fatigue.
 * Fatigue = for the last N consecutive days, CTR drops each day-to-day AND overall drop > threshold AND frequency > threshold on last day.
 * Returns false if we cannot get N consecutive days, or if any measurement would cause divide-by-zero.
 */
export function computeFatigue(
  adDailyRows: AdDailyRow[],
  config: VariantConfig,
  today: string,
): boolean {
  if (adDailyRows.length === 0) return false;

  // Get the last N days in chronological order
  const sorted = [...adDailyRows].sort((a, b) => a.day.localeCompare(b.day));
  const consecutive: AdDailyRow[] = [];

  // Start from today and go backwards, collecting consecutive days
  let checkDay = today;
  for (let i = 0; i < config.consecutiveDays; i++) {
    const found = sorted.find((r) => r.day === checkDay);
    if (!found) return false; // Gap in data
    consecutive.unshift(found);
    checkDay = addDays(checkDay, -1);
  }

  // Consecutive days are now in chronological order: [d-2, d-1, d]
  const ctr: (number | null)[] = [];
  for (const row of consecutive) {
    if (row.impressions === 0) return false; // Avoid divide by zero
    ctr.push(row.clicks / row.impressions);
  }

  // CTR must strictly decrease day-to-day
  for (let i = 1; i < ctr.length; i++) {
    if (ctr[i]! >= ctr[i - 1]!) return false;
  }

  // Overall drop must be > threshold percent
  const firstCtr = ctr[0]!;
  const lastCtr = ctr[ctr.length - 1]!;
  const dropPct = firstCtr > 0 ? ((firstCtr - lastCtr) / firstCtr) * 100 : 0;

  if (dropPct <= config.ctrDropPct) return false;

  // Frequency on last day must exceed threshold
  const lastFrequency = consecutive[consecutive.length - 1]!.frequency;
  if (lastFrequency <= config.frequencyThreshold) return false;

  return true;
}

/**
 * Evaluate all variants: mark winners and fatigued ads.
 * Groups ad_daily rows by campaign, computes flags.
 */
export function evaluateVariants(
  variants: VariantRow[],
  adDailyRows: AdDailyRow[],
  config: VariantConfig,
  today: string,
): VariantWithFlags[] {
  return variants.map((v) => {
    const rowsForAd = adDailyRows.filter((r) => r.ad_external_id === v.ad_external_id);
    return {
      ...v,
      winner: computeWinner(rowsForAd, adDailyRows, config, today),
      fatigue: computeFatigue(rowsForAd, config, today),
    };
  });
}
