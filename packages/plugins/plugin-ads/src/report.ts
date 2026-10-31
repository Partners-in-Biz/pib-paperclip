/**
 * The daily results report: for yesterday, one info alert per platform and currency with spend, impressions, clicks (taps on Apple), installs,
 * conversions, cost per install and CPA. It rides the alerts flow (Cockpit, `list-ad-alerts`), never opens an issue, and is refreshed in place when the
 * platform restates the day (one dedupe key per platform, currency and day). It reads the rollups only; nothing here calls a platform or changes an ad.
 */
import type { AlertCandidate } from "./alerts.js";
import { listAccounts, listScopes, summaryRows, type SummaryRow } from "./db.js";
import { addDays, todayIn } from "./dates.js";
import { raiseSweepAlert } from "./evaluate.js";
import { withDerived } from "./metrics.js";
import { formatMoney } from "./money.js";
import type { AdsRuntime } from "./runtime.js";

export function reportCandidate(row: SummaryRow, platform: string, day: string): AlertCandidate {
  const t = withDerived({ spend: row.spend, impressions: row.impressions, clicks: row.clicks, conversions: row.conversions, installs: row.installs, value: row.value });
  const money = (minor: number | null) => (minor === null ? "n/a" : formatMoney(minor, row.currency));
  const clicks = platform === "apple" ? "taps" : "clicks";
  return {
    kind: "daily_report",
    severity: "info",
    dedupeKey: `daily_report:${platform}:${row.currency}:${day}`,
    title: `Daily results: ${platform} ${day}`,
    text: `${platform} on ${day}: spend ${money(t.spend)}, ${t.impressions} impressions, ${t.clicks} ${clicks}, ${t.installs} installs (cost per install ${money(t.cpi)}), ${t.conversions} conversions (CPA ${money(t.cpa)}).`,
    detail: { platform, day, currency: row.currency, spendMinor: t.spend, impressions: t.impressions, clicks: t.clicks, installs: t.installs, conversions: t.conversions, cpiMinor: t.cpi, cpaMinor: t.cpa },
  };
}

/** Yesterday's (or `day`'s) report for every platform that has rows for it. A platform with no rows that day gets none: zero delivery is the alert rules' job. */
export async function postDailyReports(rt: AdsRuntime, options: { day?: string } = {}): Promise<{ day: string; reports: number }> {
  const day = options.day ?? addDays(todayIn(rt.config.timezone, rt.now()), -1);
  const rows = await summaryRows(rt.ctx, rt.companyId, { since: day, until: day, groupBy: "platform" });
  if (rows.length === 0) return { day, reports: 0 };
  const scopes = await listScopes(rt.ctx, rt.companyId);
  const accounts = (await listAccounts(rt.ctx, rt.companyId)).filter((a) => a.status === "active");
  let reports = 0;
  for (const row of rows) {
    const platform = row.key;
    // An alert belongs to a scope: use the first scope that has an account on this platform.
    const scopeKey = accounts.filter((a) => a.platform === platform).map((a) => a.scope_key).sort()[0];
    const scope = scopes.find((s) => s.scope_key === scopeKey);
    if (!scope) continue;
    await raiseSweepAlert(rt, scope, reportCandidate(row, platform, day), {});
    reports += 1;
  }
  return { day, reports };
}
