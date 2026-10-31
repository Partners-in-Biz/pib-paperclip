/**
 * The daily results report: for yesterday, one info alert per scope, platform and currency with spend, impressions, clicks (taps on Apple), installs,
 * conversions, cost per install and CPA. It rides the alerts flow (Cockpit, `list-ad-alerts`), never opens an issue, and is refreshed in place when the
 * platform restates the day (one dedupe key per scope, platform, currency and day). It reads the rollups only; nothing here calls a platform or changes an ad.
 */
import type { AlertCandidate } from "./alerts.js";
import { listScopes, summaryRows, type SummaryRow } from "./db.js";
import { addDays, todayIn } from "./dates.js";
import { raiseSweepAlert } from "./evaluate.js";
import { withDerived } from "./metrics.js";
import { formatMoney } from "./money.js";
import type { AdsRuntime } from "./runtime.js";

export function reportCandidate(row: SummaryRow, scopeKey: string, platform: string, day: string): AlertCandidate {
  const t = withDerived({ spend: row.spend, impressions: row.impressions, clicks: row.clicks, conversions: row.conversions, installs: row.installs, value: row.value });
  const money = (minor: number | null) => (minor === null ? "n/a" : formatMoney(minor, row.currency));
  const clicks = platform === "apple" ? "taps" : "clicks";
  return {
    kind: "daily_report",
    severity: "info",
    dedupeKey: `daily_report:${scopeKey}:${platform}:${row.currency}:${day}`,
    title: `Daily results: ${platform} ${day}`,
    text: `${platform} on ${day}: spend ${money(t.spend)}, ${t.impressions} impressions, ${t.clicks} ${clicks}, ${t.installs} installs (cost per install ${money(t.cpi)}), ${t.conversions} conversions (CPA ${money(t.cpa)}).`,
    detail: { scopeKey, platform, day, currency: row.currency, spendMinor: t.spend, impressions: t.impressions, clicks: t.clicks, installs: t.installs, conversions: t.conversions, cpiMinor: t.cpi, cpaMinor: t.cpa },
  };
}

/** Yesterday's (or `day`'s) report for every scope and platform that has rows for it. A scope with no rows that day gets none: zero delivery is the alert rules' job. Each scope's report holds only that scope's numbers. */
export async function postDailyReports(rt: AdsRuntime, options: { day?: string } = {}): Promise<{ day: string; reports: number }> {
  const day = options.day ?? addDays(todayIn(rt.config.timezone, rt.now()), -1);
  let reports = 0;
  for (const scope of await listScopes(rt.ctx, rt.companyId)) {
    const rows = await summaryRows(rt.ctx, rt.companyId, { since: day, until: day, groupBy: "platform", scopeKey: scope.scope_key });
    for (const row of rows) {
      await raiseSweepAlert(rt, scope, reportCandidate(row, scope.scope_key, row.key, day), {});
      reports += 1;
    }
  }
  return { day, reports };
}
