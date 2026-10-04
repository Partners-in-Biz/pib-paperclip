/**
 * Anomaly detection on the daily rollups (pure: rows in, candidates out; the sync job decides what to open).
 *
 * Every candidate has a dedupe key, so the same anomaly is one alert however many syncs see it. The rules are plain on purpose:
 * a person must be able to read why an alert fired.
 */
import { addDays, isoWeek } from "./dates.js";
import { mean, median, sumRows } from "./metrics.js";
import { formatMoney } from "./money.js";
import type { Pace } from "./budgets.js";
import type { AlertKind } from "./platforms.js";

export interface SeriesPoint {
  day: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  value?: number;
}

export interface AlertCandidate {
  kind: AlertKind;
  severity: "info" | "warn" | "bad";
  /** One alert per key: syncs that see the same anomaly again update it, never duplicate it. */
  dedupeKey: string;
  title: string;
  /** One or two plain sentences for the issue and the Cockpit. */
  text: string;
  detail: Record<string, unknown>;
  /** Alerts that need a person's decision open an approval issue; the rest go to the ads agent. */
  needsDecision?: boolean;
}

export interface AlertConfig {
  /** A day's spend this many times the recent median is a spike. */
  spikeFactor: number;
  /** ...and at least this much, in minor units, so a campaign that normally spends cents does not page anyone. */
  spikeMinMinor: number;
  /** Delivered on at least this many of the 3 days before a silent day, or it is just a campaign that never ran. */
  zeroDeliveryPriorDays: number;
  /** 7-day cost per result this far above the target (0.25 is 25%) is over target. */
  cpaTolerance: number;
  cpaMinConversions: number;
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  spikeFactor: 2.5,
  spikeMinMinor: 5000,
  zeroDeliveryPriorDays: 2,
  cpaTolerance: 0.25,
  cpaMinConversions: 3,
};

interface CampaignRef {
  accountId: string;
  externalId: string;
  name: string;
  status: string;
}

const money = (minor: number | null, currency: string) => formatMoney(minor, currency);

/** The latest day's spend against the median of the (up to 7) days before it. */
export function detectSpendSpike(input: { campaign: CampaignRef; series: SeriesPoint[]; currency: string; config?: Partial<AlertConfig> }): AlertCandidate | null {
  const cfg = { ...DEFAULT_ALERT_CONFIG, ...input.config };
  const points = [...input.series].sort((a, b) => (a.day < b.day ? -1 : 1));
  const latest = points[points.length - 1];
  if (!latest) return null;
  const prior = points.filter((p) => p.day < latest.day && p.day >= addDays(latest.day, -7) && p.spend > 0).map((p) => p.spend);
  if (prior.length < 3) return null;
  const baseline = median(prior)!;
  if (latest.spend < cfg.spikeMinMinor || latest.spend <= baseline * cfg.spikeFactor) return null;
  const times = Math.round((latest.spend / baseline) * 10) / 10;
  return {
    kind: "spend_spike",
    severity: "warn",
    dedupeKey: `spike:${input.campaign.accountId}:${input.campaign.externalId}:${latest.day}`,
    title: `Spend spike: ${input.campaign.name}`,
    text: `${input.campaign.name} spent ${money(latest.spend, input.currency)} on ${latest.day}, ${times} times its usual ${money(Math.round(baseline), input.currency)} a day.`,
    detail: { campaign: input.campaign.externalId, day: latest.day, spendMinor: latest.spend, baselineMinor: Math.round(baseline), times },
  };
}

/**
 * An active campaign that delivered on the days before and showed nothing yesterday. `syncFresh` says the numbers are
 * current (the account synced after yesterday ended): without it a missing row only means we have not looked.
 */
export function detectZeroDelivery(input: { campaign: CampaignRef; series: SeriesPoint[]; today: string; syncFresh: boolean; config?: Partial<AlertConfig> }): AlertCandidate | null {
  const cfg = { ...DEFAULT_ALERT_CONFIG, ...input.config };
  if (input.campaign.status !== "active" || !input.syncFresh) return null;
  const yesterday = addDays(input.today, -1);
  const byDay = new Map(input.series.map((p) => [p.day, p]));
  if ((byDay.get(yesterday)?.impressions ?? 0) > 0) return null;
  const before = [2, 3, 4].map((n) => byDay.get(addDays(input.today, -n))).filter((p): p is SeriesPoint => Boolean(p && p.impressions > 0));
  if (before.length < cfg.zeroDeliveryPriorDays) return null;
  return {
    kind: "zero_delivery",
    severity: "warn",
    dedupeKey: `zero:${input.campaign.accountId}:${input.campaign.externalId}:${yesterday}`,
    title: `No delivery: ${input.campaign.name}`,
    text: `${input.campaign.name} is active but showed no ads on ${yesterday}, after delivering on ${before.length} of the 3 days before. Common causes: ads in review or rejected, a payment problem, an audience or budget that is too small, or an end date.`,
    detail: { campaign: input.campaign.externalId, day: yesterday, priorDaysDelivered: before.length },
  };
}

/** The last 7 days' cost per result against the scope's target. Also: real spend and no result at all. */
export function detectCpaOverTarget(input: { campaign: CampaignRef; series: SeriesPoint[]; today: string; targetCpaMinor: number | null; currency: string; config?: Partial<AlertConfig> }): AlertCandidate | null {
  const cfg = { ...DEFAULT_ALERT_CONFIG, ...input.config };
  const target = input.targetCpaMinor;
  if (!target || target <= 0) return null;
  const window = input.series.filter((p) => p.day >= addDays(input.today, -7) && p.day <= input.today);
  const totals = sumRows(window);
  const key = `cpa:${input.campaign.accountId}:${input.campaign.externalId}:${isoWeek(input.today)}`;
  if (totals.conversions === 0 && totals.spend >= target * 2) {
    return {
      kind: "cpa_over_target",
      severity: totals.spend >= target * 3 ? "bad" : "warn",
      dedupeKey: key,
      title: `Spend with no results: ${input.campaign.name}`,
      text: `${input.campaign.name} spent ${money(totals.spend, input.currency)} in the last 7 days with no conversions. The target cost per result is ${money(target, input.currency)}.`,
      detail: { campaign: input.campaign.externalId, spendMinor: totals.spend, conversions: 0, targetMinor: target },
    };
  }
  if (totals.conversions < cfg.cpaMinConversions) return null;
  const cpa = Math.round(totals.spend / totals.conversions);
  if (cpa <= target * (1 + cfg.cpaTolerance)) return null;
  return {
    kind: "cpa_over_target",
    severity: cpa > target * 2 ? "bad" : "warn",
    dedupeKey: key,
    title: `Cost per result over target: ${input.campaign.name}`,
    text: `${input.campaign.name} cost ${money(cpa, input.currency)} per result over the last 7 days (${totals.conversions} results), against a target of ${money(target, input.currency)}.`,
    detail: { campaign: input.campaign.externalId, cpaMinor: cpa, targetMinor: target, conversions: totals.conversions, spendMinor: totals.spend },
  };
}

/** Budget alerts for a scope's month. The 90% one asks a person to pause: nothing here pauses anything. */
export function budgetAlerts(input: { scopeKey: string; scopeLabel: string; pace: Pace; currency: string; alertPct: number }): AlertCandidate[] {
  const { pace, currency } = input;
  if (pace.capMinor === null || pace.pctUsed === null) return [];
  const used = Math.round(pace.pctUsed * 100);
  const base = { spentMinor: pace.spentMinor, capMinor: pace.capMinor, pctUsed: used, month: pace.month, projectedRunRateMinor: pace.projectedRunRateMinor };
  if (pace.state === "over") {
    return [{
      kind: "budget_100",
      severity: "bad",
      dedupeKey: `budget100:${input.scopeKey}:${pace.month}`,
      title: `Budget used up: ${input.scopeLabel}`,
      text: `${input.scopeLabel} has spent ${money(pace.spentMinor, currency)} of its ${money(pace.capMinor, currency)} budget for ${pace.month} (${used}%). Ads that are still running are spending money the budget does not cover.`,
      detail: base,
      needsDecision: true,
    }];
  }
  if (pace.state === "alert") {
    return [{
      kind: "budget_90",
      severity: "warn",
      dedupeKey: `budget90:${input.scopeKey}:${pace.month}`,
      title: `Budget ${used}% used: ${input.scopeLabel}`,
      text: `${input.scopeLabel} has spent ${money(pace.spentMinor, currency)} of its ${money(pace.capMinor, currency)} budget for ${pace.month} (${used}%), with ${pace.daysLeft} days left. At the current pace it ends the month near ${money(pace.projectedRunRateMinor, currency)}.`,
      detail: { ...base, alertPct: input.alertPct },
      needsDecision: true,
    }];
  }
  if (pace.onTrackToExceed && pace.daysLeft >= 3 && pace.pctUsed >= 0.5) {
    return [{
      kind: "on_track_to_exceed",
      severity: "info",
      dedupeKey: `overrun:${input.scopeKey}:${pace.month}`,
      title: `On track to exceed the budget: ${input.scopeLabel}`,
      text: `${input.scopeLabel} has spent ${money(pace.spentMinor, currency)} of ${money(pace.capMinor, currency)} (${used}%) and, at the last days' pace, ends ${pace.month} near ${money(pace.projectedRunRateMinor, currency)}.`,
      detail: base,
    }];
  }
  return [];
}

/** Average of the last complete days' spend, for display and the run-rate. */
export function averageDaily(series: SeriesPoint[], today: string, days = 7): number {
  const window = series.filter((p) => p.day < today && p.day >= addDays(today, -days));
  return Math.round(mean(window.map((p) => p.spend)) ?? 0);
}
