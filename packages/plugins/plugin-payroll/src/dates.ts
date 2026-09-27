/**
 * Dates in worker texts people read (the setup checklist, the Cockpit):
 * "25 Sep 2026" and "Sep 2026", the same as the Payroll page shows them
 * (pib-plugin-ui `formatDate` / `formatMonth`). Never 2026-09-25 on screen.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function parts(value: string | null | undefined): { y: number; m: number; d: number | null } | null {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec((value ?? "").trim());
  if (!match) return null;
  const m = Number(match[2]);
  if (m < 1 || m > 12) return null;
  return { y: Number(match[1]), m, d: match[3] ? Number(match[3]) : null };
}

/** "2026-09-25" (or an ISO timestamp) → "25 Sep 2026"; "–" when missing. */
export function readableDate(value: string | null | undefined): string {
  const p = parts(value);
  if (!p) return "–";
  return p.d ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : `${MONTHS[p.m - 1]} ${p.y}`;
}

/** "2026-09" or "2026-09-25" → "Sep 2026"; "–" when missing. */
export function readableMonth(value: string | null | undefined): string {
  const p = parts(value);
  return p ? `${MONTHS[p.m - 1]} ${p.y}` : "–";
}
