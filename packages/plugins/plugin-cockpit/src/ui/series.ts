/**
 * Chart series for the Cockpit (pure, no React). Runs per day follow the
 * host's Run Activity chart: UTC days, succeeded / failed (incl. timed out) /
 * other.
 */
import type { ColumnDatum } from "@partnersinbiz/pib-plugin-ui";
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

/** Column data for `BarChart`: axis label `9/26`, tooltip heading `Fri 26 Sep`. */
export function runColumns(days: RunDay[]): ColumnDatum[] {
  return days.map((day) => {
    const d = new Date(`${day.date}T12:00:00Z`);
    return {
      label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
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
