/**
 * Chart series for the Cockpit (pure, no React). Runs per day follow the
 * host's Run Activity chart: UTC days, succeeded / failed (incl. timed out) /
 * other.
 */
import { formatShortDate, type ColumnDatum } from "@partnersinbiz/pib-plugin-ui";
import type { HealthGroup, HealthStatus, RunLite } from "../merge.js";

const FAILED = new Set(["failed", "error", "timed_out", "timeout", "cancelled_error"]);
const SUCCEEDED = new Set(["succeeded", "success", "completed"]);

export interface RunDay {
  date: string;
  succeeded: number;
  failed: number;
  other: number;
  total: number;
}

/** The last `days` UTC dates, oldest first, ending today. */
export function lastDays(now: Date, days: number): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

export function runsPerDay(runs: RunLite[], now: Date, days = 14): RunDay[] {
  const out = new Map(lastDays(now, days).map((date) => [date, { date, succeeded: 0, failed: 0, other: 0, total: 0 }]));
  for (const run of runs) {
    const t = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    if (Number.isNaN(t)) continue;
    const day = out.get(new Date(t).toISOString().slice(0, 10));
    if (!day) continue;
    if (SUCCEEDED.has(run.status)) day.succeeded += 1;
    else if (FAILED.has(run.status)) day.failed += 1;
    else day.other += 1;
    day.total += 1;
  }
  return [...out.values()];
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Column data for `BarChart`: axis label `26 Sep` (the shared short date), tooltip heading `Fri 26 Sep`. */
export function runColumns(days: RunDay[], now: Date = new Date()): ColumnDatum[] {
  return days.map((day) => {
    const d = new Date(`${day.date}T12:00:00Z`);
    return {
      label: formatShortDate(day.date, now),
      title: `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`,
      values: { succeeded: day.succeeded, failed: day.failed, other: day.other },
    };
  });
}

/** Number of health checks per status across all groups. */
export function healthCounts(groups: HealthGroup[]): Record<HealthStatus, number> {
  const counts: Record<HealthStatus, number> = { ok: 0, warn: 0, bad: 0 };
  for (const group of groups) for (const check of group.checks) counts[check.status] += 1;
  return counts;
}

export interface RunStats {
  total: number;
  failed: number;
  succeeded: number;
}

/** Runs started in the window (the page's "last 24 hours" or "last 7 days"), failed ones counted like the chart. */
export function runStats(runs: RunLite[], now: Date, windowMs: number): RunStats {
  const from = now.getTime() - windowMs;
  const out: RunStats = { total: 0, failed: 0, succeeded: 0 };
  for (const run of runs) {
    const t = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
    if (Number.isNaN(t) || t < from || t > now.getTime() + 60_000) continue;
    out.total += 1;
    if (FAILED.has(run.status)) out.failed += 1;
    else if (SUCCEEDED.has(run.status)) out.succeeded += 1;
  }
  return out;
}

/**
 * The Today card's run line when runs fail: "All 15 runs in the last 24 hours
 * failed" (bad) or "4 of 20 runs in the last 7 days failed" (warn). Null when
 * nothing failed.
 */
export function runAlert(stats: RunStats, windowHours: number): { text: string; tone: "bad" | "warn" } | null {
  if (stats.failed === 0) return null;
  const period = windowHours >= 168 ? "in the last 7 days" : windowHours === 24 ? "in the last 24 hours" : `in the last ${windowHours} hours`;
  if (stats.failed >= stats.total) return { text: stats.total === 1 ? `The only run ${period} failed` : `All ${stats.total} runs ${period} failed`, tone: "bad" };
  return { text: `${stats.failed} of ${stats.total} runs ${period} failed`, tone: stats.failed * 2 >= stats.total ? "bad" : "warn" };
}
