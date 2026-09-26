/**
 * Leave under the Basic Conditions of Employment Act (BCEA), ported and
 * extended from the old platform's `lib/payroll/leave.ts`.
 *
 * - Annual: 21 consecutive days per 12-month cycle, i.e. 15 working days
 *   for a 5-day week (days per week × 3), accrued monthly.
 * - Sick: 6 weeks' working days per 36-month cycle (30 days for a 5-day
 *   week); in the first 6 months, 1 day for every 26 days worked.
 * - Family responsibility: 3 days per annual cycle, after 4 months' service,
 *   for employees working at least 4 days a week.
 * - Unpaid: no entitlement; approved unpaid leave reduces pay in the run.
 *
 * Balances are worked out from the start date, opening balances and
 * approved requests, so nothing has to be accrued by a job. Days are held
 * in centi-days (1.5 days = 150).
 */
import { PayrollError } from "./money.js";

export type LeaveType = "annual" | "sick" | "family" | "unpaid";
export const LEAVE_TYPES: LeaveType[] = ["annual", "sick", "family", "unpaid"];

export const LEAVE_LABELS: Record<LeaveType, string> = {
  annual: "Annual leave",
  sick: "Sick leave",
  family: "Family responsibility leave",
  unpaid: "Unpaid leave",
};

export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface LeaveRequestLike {
  id: string;
  type: LeaveType;
  status: LeaveStatus;
  startDate: string;
  endDate: string;
  daysCenti: number;
}

export interface LeaveOpening {
  type: LeaveType;
  daysCenti: number;
  asOf: string;
}

export interface LeaveBalance {
  type: LeaveType;
  label: string;
  entitlementCenti: number;
  takenCenti: number;
  pendingCenti: number;
  balanceCenti: number;
  cycleStart: string | null;
  cycleEnd: string | null;
  note: string | null;
}

export function assertLeaveType(value: unknown): LeaveType {
  if (typeof value === "string" && (LEAVE_TYPES as string[]).includes(value)) return value as LeaveType;
  throw new PayrollError(`Leave type must be one of: ${LEAVE_TYPES.join(", ")}`);
}

function parse(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new PayrollError("Dates must be YYYY-MM-DD");
  return new Date(`${date}T00:00:00Z`);
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addMonths(date: string, months: number): string {
  const d = parse(date);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return iso(target);
}

function addDays(date: string, days: number): string {
  const d = parse(date);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
}

/** Completed whole months from `start` up to `asOf`. */
export function completedMonths(start: string, asOf: string): number {
  if (asOf < start) return 0;
  let months = 0;
  while (addMonths(start, months + 1) <= addDays(asOf, 1)) months += 1;
  return months;
}

/** Working days (Mon–Fri, or Mon–Sat for a 6-day week) between two dates, inclusive. Public holidays are not excluded. */
export function workingDaysBetween(startDate: string, endDate: string, daysPerWeek = 5): number {
  if (endDate < startDate) throw new PayrollError("Leave ends before it starts");
  let count = 0;
  let cursor = parse(startDate);
  const end = parse(endDate);
  while (cursor <= end) {
    const day = cursor.getUTCDay(); // 0 Sunday
    const working = daysPerWeek >= 7 ? true : daysPerWeek === 6 ? day !== 0 : day !== 0 && day !== 6;
    if (working) count += 1;
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return count;
}

/** The cycle (start, end) of `lengthMonths` months that contains `asOf`, counting from `employmentStart`. */
export function cycleContaining(employmentStart: string, asOf: string, lengthMonths: number): { start: string; end: string } {
  let start = employmentStart;
  while (addMonths(start, lengthMonths) <= asOf) start = addMonths(start, lengthMonths);
  return { start, end: addDays(addMonths(start, lengthMonths), -1) };
}

function sumDays(requests: LeaveRequestLike[], type: LeaveType, status: LeaveStatus, from: string | null, to: string | null): number {
  return requests
    .filter((r) => r.type === type && r.status === status && (!from || r.endDate >= from) && (!to || r.startDate <= to))
    .reduce((sum, r) => sum + r.daysCenti, 0);
}

export interface BalanceInput {
  employmentStart: string;
  asOf: string;
  daysPerWeek: number;
  /** Annual leave days per cycle when more generous than BCEA; defaults to days per week × 3. */
  annualDaysPerYear?: number | null;
  requests: LeaveRequestLike[];
  openings?: LeaveOpening[];
}

export function leaveBalances(input: BalanceInput): LeaveBalance[] {
  const { employmentStart, asOf, requests } = input;
  const daysPerWeek = Math.max(1, Math.min(7, Math.round(input.daysPerWeek || 5)));
  const opening = (type: LeaveType) => (input.openings ?? []).find((o) => o.type === type) ?? null;
  const balances: LeaveBalance[] = [];
  if (asOf < employmentStart) {
    return LEAVE_TYPES.map((type) => ({ type, label: LEAVE_LABELS[type], entitlementCenti: 0, takenCenti: 0, pendingCenti: 0, balanceCenti: 0, cycleStart: null, cycleEnd: null, note: "Not started yet" }));
  }

  // Annual: accrues monthly; carries over (the BCEA lets unused leave be taken within 6 months of the cycle end).
  {
    const perYear = (input.annualDaysPerYear ?? daysPerWeek * 3) * 100;
    const open = opening("annual");
    const accrueFrom = open ? open.asOf : employmentStart;
    const months = completedMonths(accrueFrom, asOf);
    const accrued = Math.floor((perYear * months) / 12) + (open?.daysCenti ?? 0);
    const taken = sumDays(requests, "annual", "approved", open ? addDays(open.asOf, 1) : null, null);
    balances.push({
      type: "annual",
      label: LEAVE_LABELS.annual,
      entitlementCenti: accrued,
      takenCenti: taken,
      pendingCenti: sumDays(requests, "annual", "pending", null, null),
      balanceCenti: accrued - taken,
      cycleStart: cycleContaining(employmentStart, asOf, 12).start,
      cycleEnd: cycleContaining(employmentStart, asOf, 12).end,
      note: `${perYear / 100} days a year, accrued monthly`,
    });
  }

  // Sick: 36-month cycles; the first 6 months earn 1 day per 26 days worked.
  {
    const cycle = cycleContaining(employmentStart, asOf, 36);
    const firstCycle = cycle.start === employmentStart;
    const monthsIn = completedMonths(employmentStart, asOf);
    let entitlement = daysPerWeek * 6 * 100;
    let note = `${daysPerWeek * 6} days per 36-month cycle`;
    if (firstCycle && monthsIn < 6) {
      const worked = workingDaysBetween(employmentStart, asOf, daysPerWeek);
      entitlement = Math.floor((worked * 100) / 26);
      note = "First 6 months: 1 day for every 26 days worked";
    }
    // An opening balance inside the current cycle replaces the entitlement: it is what was left on that date.
    const open = opening("sick");
    const useOpening = Boolean(open && open.asOf >= cycle.start && open.asOf <= cycle.end);
    const available = useOpening ? open!.daysCenti : entitlement;
    const taken = sumDays(requests, "sick", "approved", useOpening ? addDays(open!.asOf, 1) : cycle.start, cycle.end);
    if (useOpening) note = `${note}; opening balance ${open!.daysCenti / 100} days on ${open!.asOf}`;
    balances.push({
      type: "sick",
      label: LEAVE_LABELS.sick,
      entitlementCenti: available,
      takenCenti: taken,
      pendingCenti: sumDays(requests, "sick", "pending", null, null),
      balanceCenti: available - taken,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      note,
    });
  }

  // Family responsibility: 3 days per annual cycle after 4 months, 4+ days a week.
  {
    const cycle = cycleContaining(employmentStart, asOf, 12);
    const qualifies = completedMonths(employmentStart, asOf) >= 4 && daysPerWeek >= 4;
    const entitlement = qualifies ? 300 : 0;
    const taken = sumDays(requests, "family", "approved", cycle.start, cycle.end);
    balances.push({
      type: "family",
      label: LEAVE_LABELS.family,
      entitlementCenti: entitlement,
      takenCenti: taken,
      pendingCenti: sumDays(requests, "family", "pending", null, null),
      balanceCenti: entitlement - taken,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      note: qualifies ? "3 days per year" : "Available after 4 months' service for staff working 4 or more days a week",
    });
  }

  // Unpaid: no balance; shows what was taken in the current annual cycle.
  {
    const cycle = cycleContaining(employmentStart, asOf, 12);
    const taken = sumDays(requests, "unpaid", "approved", cycle.start, cycle.end);
    balances.push({
      type: "unpaid",
      label: LEAVE_LABELS.unpaid,
      entitlementCenti: 0,
      takenCenti: taken,
      pendingCenti: sumDays(requests, "unpaid", "pending", null, null),
      balanceCenti: 0,
      cycleStart: cycle.start,
      cycleEnd: cycle.end,
      note: "Deducted from pay in the pay run",
    });
  }
  return balances;
}

/**
 * Approved unpaid leave that falls in a pay period, in centi-hours. A request
 * spanning two periods is split by working days.
 */
export function unpaidLeaveHoursInPeriod(
  requests: LeaveRequestLike[],
  periodStart: string,
  periodEnd: string,
  hoursPerDayCenti: number,
  daysPerWeek = 5,
): number {
  return leaveHoursInPeriod(requests, ["unpaid"], periodStart, periodEnd, hoursPerDayCenti, daysPerWeek);
}

/** Approved paid leave (annual, sick, family) in a period, in centi-hours: hourly staff are paid for it. */
export function paidLeaveHoursInPeriod(
  requests: LeaveRequestLike[],
  periodStart: string,
  periodEnd: string,
  hoursPerDayCenti: number,
  daysPerWeek = 5,
): number {
  return leaveHoursInPeriod(requests, ["annual", "sick", "family"], periodStart, periodEnd, hoursPerDayCenti, daysPerWeek);
}

function leaveHoursInPeriod(
  requests: LeaveRequestLike[],
  types: LeaveType[],
  periodStart: string,
  periodEnd: string,
  hoursPerDayCenti: number,
  daysPerWeek: number,
): number {
  let hours = 0;
  for (const r of requests) {
    if (!types.includes(r.type) || r.status !== "approved") continue;
    if (r.endDate < periodStart || r.startDate > periodEnd) continue;
    const totalDays = workingDaysBetween(r.startDate, r.endDate, daysPerWeek);
    const inside = workingDaysBetween(r.startDate > periodStart ? r.startDate : periodStart, r.endDate < periodEnd ? r.endDate : periodEnd, daysPerWeek);
    const daysCenti = totalDays > 0 ? Math.round((r.daysCenti * inside) / totalDays) : 0;
    hours += Math.round((daysCenti * hoursPerDayCenti) / 100);
  }
  return hours;
}

/** Validates a request against the balance (unpaid leave has no limit). */
export function checkLeaveRequest(balance: LeaveBalance | undefined, type: LeaveType, daysCenti: number): string | null {
  if (!Number.isInteger(daysCenti) || daysCenti <= 0) return "The number of days must be more than zero";
  if (type === "unpaid" || !balance) return null;
  if (daysCenti > balance.balanceCenti - balance.pendingCenti) {
    return `Only ${(balance.balanceCenti - balance.pendingCenti) / 100} ${balance.label.toLowerCase()} days are available`;
  }
  return null;
}
