/**
 * Per-day chart series for the Mailbox page (pure).
 */

/** Days of per-day counts on the page. */
export const DAILY_DAYS = 14;

/** `dailyCounts` rows → mail received per day and category, sends per day and status. */
export function shapeDaily(rows: Array<{ kind: string; day: string; key: string | null; n: string | number }>, days = DAILY_DAYS) {
  const received: Array<{ date: string; category: string; count: number }> = [];
  const sends: Array<{ date: string; status: string; count: number }> = [];
  for (const row of rows) {
    const count = Number(row.n ?? 0);
    if (!row.day || !Number.isFinite(count)) continue;
    if (row.kind === "received") received.push({ date: row.day, category: row.key ?? "untriaged", count });
    else if (row.kind === "send" && row.key) sends.push({ date: row.day, status: row.key, count });
  }
  const order = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
  return { days, received: received.sort(order), sends: sends.sort(order) };
}

export type DailySeries = ReturnType<typeof shapeDaily>;
