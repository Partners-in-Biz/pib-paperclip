/**
 * Week keys in SAST (UTC+2), shared by the Daily brief issue, the business
 * review and the goals' weekly values. Pure, no node imports.
 */

/** ISO week key, e.g. `2026-W39`, in SAST (UTC+2). */
export function weekKey(date: Date): string {
  const sast = new Date(date.getTime() + 2 * 3_600_000);
  const d = new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The Monday of the week a date falls in (SAST), as `YYYY-MM-DD`. */
export function mondayLabel(date: Date): string {
  const sast = new Date(date.getTime() + 2 * 3_600_000);
  const day = sast.getUTCDay() || 7;
  const monday = new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate() - day + 1));
  return monday.toISOString().slice(0, 10);
}

/** The week key of the week before the one `date` falls in. */
export function previousWeekKey(date: Date): string {
  return weekKey(new Date(date.getTime() - 7 * 86_400_000));
}
