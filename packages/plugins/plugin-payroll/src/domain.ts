/**
 * Pay run rules that do not touch the database: the status machine,
 * separation of duties, numbering, default periods, SDL applicability and
 * variance checks.
 *
 *   draft → calculated → pending_approval → approved → locked
 *     ↑________|______________|  (recalculating or adjusting drops the approval)
 *   draft / calculated → cancelled;  locked → reversed (by a locked reversal run)
 */
import { PayrollError } from "./money.js";
import type { PayFrequency } from "./rules.js";

export type RunStatus = "draft" | "calculated" | "pending_approval" | "approved" | "locked" | "reversed" | "cancelled";
export type RunKind = "regular" | "correction" | "reversal";

export interface Actor {
  kind: "user" | "agent" | "system";
  userId: string | null;
  agentId: string | null;
}

export interface RunState {
  status: RunStatus;
  kind: RunKind;
  preparedByUserId: string | null;
  preparedByAgentId: string | null;
  approverUserId: string | null;
}

export const LOCAL_BOARD_USER_ID = "local-board";

export function assertCanCalculate(run: RunState): void {
  if (run.kind === "reversal") throw new PayrollError("A reversal run copies the original run; it is not recalculated");
  if (!["draft", "calculated", "pending_approval"].includes(run.status)) {
    throw new PayrollError(`A ${words(run.status)} pay run cannot be recalculated`);
  }
}

export function assertCanAdjust(run: RunState): void {
  if (run.kind === "reversal") throw new PayrollError("A reversal run cannot be adjusted");
  if (!["draft", "calculated", "pending_approval"].includes(run.status)) {
    throw new PayrollError(`A ${words(run.status)} pay run cannot be changed. Correct it with a new run.`);
  }
}

/** The approver must be a board user and must not be the person who prepared the run. */
export function assertApproverAllowed(run: RunState, approverUserId: string | null | undefined): string {
  if (!approverUserId) throw new PayrollError("Choose a board member to approve the pay run");
  if (run.preparedByUserId && approverUserId === run.preparedByUserId) {
    throw new PayrollError("The person who prepared the pay run cannot approve it. Choose someone else.");
  }
  return approverUserId;
}

export function assertCanRequestApproval(run: RunState, itemCount: number, errorCount: number): void {
  if (run.status !== "calculated") throw new PayrollError(run.status === "draft" ? "Calculate the pay run first" : `A ${words(run.status)} pay run cannot be sent for approval`);
  if (itemCount === 0) throw new PayrollError("The pay run has no employees");
  if (errorCount > 0) throw new PayrollError(`Fix the ${errorCount} employee(s) with errors first (or exclude them from the run)`);
}

/**
 * Only a board user may approve, never the preparer, and only the named
 * approver when one was named. Agents never approve.
 */
export function assertCanApprove(run: RunState, actor: Actor): string {
  if (run.status !== "pending_approval") throw new PayrollError(run.status === "approved" ? "The pay run is already approved" : "The pay run is not waiting for approval");
  if (actor.kind !== "user" || !actor.userId) throw new PayrollError("Only a board member can approve a pay run");
  if (run.preparedByUserId && actor.userId === run.preparedByUserId) {
    throw new PayrollError("You prepared this pay run, so someone else must approve it");
  }
  if (run.approverUserId && run.approverUserId !== actor.userId) {
    throw new PayrollError("This pay run is waiting for a different approver");
  }
  return actor.userId;
}

export function assertCanLock(run: RunState, actor: Actor): void {
  if (run.status !== "approved") throw new PayrollError(run.status === "locked" ? "The pay run is already locked" : "Only an approved pay run can be locked");
  if (actor.kind !== "user") throw new PayrollError("Only a board member can lock a pay run");
}

export function assertCanReverse(run: RunState & { reversedByRunId?: string | null }): void {
  if (run.kind === "reversal") throw new PayrollError("A reversal cannot be reversed; correct it with a new run");
  if (run.status !== "locked") throw new PayrollError("Only a locked pay run can be reversed");
  if (run.reversedByRunId) throw new PayrollError("This pay run already has a reversal");
}

export function assertCanCancel(run: RunState): void {
  if (!["draft", "calculated", "pending_approval"].includes(run.status)) throw new PayrollError(`A ${words(run.status)} pay run cannot be cancelled`);
}

function words(status: string): string {
  return status.replace(/_/g, " ");
}

/** PR-2026-09-M01: prefix, pay-date month, frequency letter, sequence. */
export function runNumber(payDate: string, frequency: PayFrequency, sequence: number, kind: RunKind = "regular"): string {
  const letter = frequency === "monthly" ? "M" : frequency === "fortnightly" ? "F" : "W";
  const prefix = kind === "reversal" ? "RV" : kind === "correction" ? "PC" : "PR";
  return `${prefix}-${payDate.slice(0, 7)}-${letter}${String(sequence).padStart(2, "0")}`;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Default period for a new run: the month containing `today` (monthly), or
 * the 14 / 7 days ending on the coming Friday (fortnightly / weekly). The
 * pay date is the default pay day (monthly, moved back to a weekday) or the
 * period end.
 */
export function defaultPeriod(frequency: PayFrequency, today: string, payDay = 25): { periodStart: string; periodEnd: string; payDate: string } {
  const [y, m] = today.split("-").map(Number) as [number, number];
  if (frequency === "monthly") {
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 0));
    const pay = new Date(Date.UTC(y, m - 1, Math.min(payDay, end.getUTCDate())));
    while (pay.getUTCDay() === 0 || pay.getUTCDay() === 6) pay.setUTCDate(pay.getUTCDate() - 1);
    return { periodStart: isoDate(start), periodEnd: isoDate(end), payDate: isoDate(pay) };
  }
  const days = frequency === "fortnightly" ? 14 : 7;
  const t = new Date(`${today}T00:00:00Z`);
  const friday = new Date(t);
  while (friday.getUTCDay() !== 5) friday.setUTCDate(friday.getUTCDate() + 1);
  const start = new Date(friday);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { periodStart: isoDate(start), periodEnd: isoDate(friday), payDate: isoDate(friday) };
}

export function assertPeriod(periodStart: string, periodEnd: string, payDate: string): void {
  for (const [label, value] of [["period start", periodStart], ["period end", periodEnd], ["pay date", payDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new PayrollError(`The ${label} must be a date (YYYY-MM-DD)`);
  }
  if (periodEnd < periodStart) throw new PayrollError("The period ends before it starts");
  const days = (Date.parse(periodEnd) - Date.parse(periodStart)) / 86_400_000;
  if (days > 31) throw new PayrollError("A pay period can be at most one month");
}

/**
 * Whether SDL applies this run. `auto` charges SDL when the yearly leviable
 * amount (this run's leviable amount × periods per year, plus other
 * frequencies' runs if known) is expected to pass the exemption threshold.
 */
export function sdlApplies(mode: "auto" | "registered" | "exempt", projectedAnnualLeviableMinor: number, thresholdMinor: number): boolean {
  if (mode === "registered") return true;
  if (mode === "exempt") return false;
  return projectedAnnualLeviableMinor > thresholdMinor;
}

export interface VarianceRow {
  employeeId: string;
  name: string;
  field: "gross" | "net" | "paye";
  previousMinor: number;
  currentMinor: number;
  changeMinor: number;
  changeBp: number | null;
}

/** Employees whose gross, net or PAYE moved by at least `thresholdBp` (default 10%) since the previous run, plus new and missing staff. */
export function variances(
  current: Array<{ employeeId: string; name: string; grossMinor: number; netMinor: number; payeMinor: number }>,
  previous: Array<{ employeeId: string; name: string; grossMinor: number; netMinor: number; payeMinor: number }>,
  thresholdBp = 1_000,
): { changes: VarianceRow[]; added: string[]; missing: string[] } {
  const prev = new Map(previous.map((p) => [p.employeeId, p]));
  const changes: VarianceRow[] = [];
  const added: string[] = [];
  for (const row of current) {
    const before = prev.get(row.employeeId);
    if (!before) {
      added.push(row.name);
      continue;
    }
    for (const [field, a, b] of [["gross", before.grossMinor, row.grossMinor], ["net", before.netMinor, row.netMinor], ["paye", before.payeMinor, row.payeMinor]] as const) {
      const change = b - a;
      const bp = a !== 0 ? Math.round((change * 10_000) / Math.abs(a)) : null;
      if (change !== 0 && (bp === null || Math.abs(bp) >= thresholdBp)) {
        changes.push({ employeeId: row.employeeId, name: row.name, field, previousMinor: a, currentMinor: b, changeMinor: change, changeBp: bp });
      }
    }
  }
  const currentIds = new Set(current.map((c) => c.employeeId));
  const missing = previous.filter((p) => !currentIds.has(p.employeeId)).map((p) => p.name);
  return { changes, added, missing };
}
