/** The date range of the Results section. No server imports: the UI bundle uses it. */
export interface ResultsRange {
  /** Only events at or after this date (inclusive). */
  from?: string;
  /** Only events before this date (EXCLUSIVE). */
  to?: string;
}

/** The last day picked is counted: the read takes the day after as its (exclusive) end. */
export function rangeParams(from: string, to: string): ResultsRange {
  let end: string | undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    const next = new Date(`${to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    end = next.toISOString().slice(0, 10);
  }
  return { from: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : undefined, to: end };
}
