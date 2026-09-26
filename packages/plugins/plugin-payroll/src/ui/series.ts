/**
 * Chart series and status tones for the Payroll page (pure, no React).
 * Charts only use run totals: no names, ID numbers or per-person pay.
 */

export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export interface RunTotalsLite {
  employeeCount: number;
  grossMinor: number;
  payeMinor: number;
  uifEmployeeMinor: number;
  uifEmployerMinor: number;
  sdlMinor: number;
  deductionsMinor: number;
  employerContributionsMinor: number;
  netPayMinor: number;
  employerCostMinor: number;
}

export interface RunLite {
  id: string;
  number: string;
  kind: string;
  status: string;
  payDate: string;
  totals: RunTotalsLite;
}

/** One tone scale: locked green, waiting for approval amber, calculated / approved / draft blue, cancelled or reversed grey. */
export function runTone(status: string): Tone {
  if (status === "locked") return "ok";
  if (status === "pending_approval") return "warn";
  if (status === "failed" || status === "error") return "bad";
  if (status === "draft" || status === "calculated" || status === "approved") return "info";
  return "neutral";
}

/** Leave requests, payslips and pay-run items. */
export function statusTone(status: string): Tone {
  if (["approved", "sent", "locked", "active", "ok", "posted", "reconciled"].includes(status)) return "ok";
  if (["pending", "pending_approval", "review"].includes(status)) return "warn";
  if (["failed", "error", "rejected", "declined", "blocked"].includes(status)) return "bad";
  if (["ready", "draft", "calculated", "queued", "scheduled"].includes(status)) return "info";
  return "neutral";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Cost of the last `limit` locked regular runs, oldest first, split into what
 * staff take home, PAYE + employee UIF, other deductions, and employer costs
 * (employer UIF, SDL and employer contributions). Without fringe benefits
 * the parts add up to the cost to company.
 */
export function costPerRun(runs: RunLite[], limit = 12) {
  return runs
    .filter((r) => r.status === "locked" && r.kind !== "reversal")
    .sort((a, b) => a.payDate.localeCompare(b.payDate))
    .slice(-limit)
    .map((r) => {
      const t = r.totals;
      const d = new Date(`${r.payDate}T12:00:00Z`);
      return {
        id: r.id,
        label: `${MONTHS[d.getUTCMonth()]}`,
        title: `${r.number} · paid ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
        values: {
          net: t.netPayMinor,
          tax: t.payeMinor + t.uifEmployeeMinor,
          deductions: t.deductionsMinor,
          employer: t.uifEmployerMinor + t.sdlMinor + t.employerContributionsMinor,
        },
        employerCostMinor: t.employerCostMinor,
        employeeCount: t.employeeCount,
      };
    });
}

/** Where the cost to company of one run goes. */
export function costSplit(t: RunTotalsLite): Array<{ key: string; label: string; value: number }> {
  return [
    { key: "net", label: "Net pay", value: t.netPayMinor },
    { key: "paye", label: "PAYE", value: t.payeMinor },
    { key: "uif", label: "UIF (both)", value: t.uifEmployeeMinor + t.uifEmployerMinor },
    { key: "sdl", label: "SDL", value: t.sdlMinor },
    { key: "deductions", label: "Deductions", value: t.deductionsMinor },
    { key: "employer", label: "Employer contributions", value: t.employerContributionsMinor },
  ].filter((s) => s.value > 0);
}

/** The EMP201 month to show on `today`: up to the 7th that is last month's (still due), after that this month's. */
export function emp201Month(today: string): string {
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  if (d > 7) return today.slice(0, 7);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/** Days from `today` to `due` (negative when past). */
export function daysUntil(today: string, due: string): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Share of a leave entitlement used (taken + pending) against what is left, 0–1. */
export function leaveUsed(b: { balanceCenti: number; takenCenti: number; pendingCenti: number }): { ratio: number; entitlementCenti: number } {
  const entitlementCenti = Math.max(0, b.balanceCenti + b.takenCenti);
  if (entitlementCenti <= 0) return { ratio: 0, entitlementCenti: 0 };
  return { ratio: Math.min(1, (b.takenCenti + b.pendingCenti) / entitlementCenti), entitlementCenti };
}
