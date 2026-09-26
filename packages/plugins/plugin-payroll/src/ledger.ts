/**
 * The pay run journal Accounting posts (kit contract `ledger.post.requested`).
 *
 * Dr salaries                 cash earnings
 * Dr employer_contributions   employer UIF + SDL + employer medical / retirement / other
 *   Cr paye_payable           PAYE less ETI used
 *   Cr revenue:employment_tax_incentive   ETI used (other income)
 *   Cr uif_payable            employee + employer UIF
 *   Cr sdl_payable            SDL
 *   Cr deductions_payable     employee deductions + employer fund / scheme contributions
 *   Cr net_pay_clearing       net pay (cleared when the bank payment is matched)
 *
 * A negative amount (correction runs) moves to the other side. Zero lines are dropped.
 */
import { isBalanced, LEDGER_EVENTS, PIB_PLUGINS, type LedgerLine, type LedgerPostRequested } from "@partnersinbiz/pib-plugin-kit";
import { PayrollError } from "./money.js";

export interface RunTotals {
  employeeCount: number;
  grossMinor: number;
  fringeBenefitsMinor: number;
  payeMinor: number;
  etiMinor: number;
  uifEmployeeMinor: number;
  uifEmployerMinor: number;
  sdlMinor: number;
  deductionsMinor: number;
  /** Employer contributions besides UIF and SDL (includes fringe benefits). */
  employerContributionsMinor: number;
  netPayMinor: number;
  employerCostMinor: number;
}

export const EMPTY_RUN_TOTALS: RunTotals = {
  employeeCount: 0,
  grossMinor: 0,
  fringeBenefitsMinor: 0,
  payeMinor: 0,
  etiMinor: 0,
  uifEmployeeMinor: 0,
  uifEmployerMinor: 0,
  sdlMinor: 0,
  deductionsMinor: 0,
  employerContributionsMinor: 0,
  netPayMinor: 0,
  employerCostMinor: 0,
};

export function addTotals(a: RunTotals, b: Partial<RunTotals>): RunTotals {
  const out = { ...a };
  for (const key of Object.keys(EMPTY_RUN_TOTALS) as Array<keyof RunTotals>) out[key] = a[key] + (b[key] ?? 0);
  return out;
}

/**
 * ETI can only reduce PAYE to zero; the rest carries forward. Reversal runs
 * hold negated totals, so the same rule applies to the absolute amounts.
 */
export function etiUsed(totals: Pick<RunTotals, "payeMinor" | "etiMinor">): number {
  if (totals.payeMinor < 0 || totals.etiMinor < 0) {
    return -Math.max(0, Math.min(Math.abs(totals.etiMinor), Math.abs(totals.payeMinor)));
  }
  return Math.max(0, Math.min(totals.etiMinor, totals.payeMinor));
}

export const LEDGER_KEY_PREFIX = "payroll:run:";

export function ledgerKey(runId: string): string {
  return `${LEDGER_KEY_PREFIX}${runId}`;
}

function side(role: LedgerLine["role"], amount: number, normal: "debit" | "credit", memo: string): LedgerLine | null {
  if (amount === 0) return null;
  const debit = (normal === "debit") === amount > 0;
  const abs = Math.abs(amount);
  return { role, debitMinor: debit ? abs : 0, creditMinor: debit ? 0 : abs, memo };
}

export function payrollJournalLines(totals: RunTotals): LedgerLine[] {
  const eti = etiUsed(totals);
  const employerSide = totals.uifEmployerMinor + totals.sdlMinor + totals.employerContributionsMinor;
  const lines = [
    side("salaries", totals.grossMinor, "debit", "Salaries and wages"),
    side("employer_contributions", employerSide, "debit", "Employer UIF, SDL and contributions"),
    side("paye_payable", totals.payeMinor - eti, "credit", eti ? "PAYE less ETI" : "PAYE"),
    side("revenue:employment_tax_incentive", eti, "credit", "Employment Tax Incentive"),
    side("uif_payable", totals.uifEmployeeMinor + totals.uifEmployerMinor, "credit", "UIF (employee and employer)"),
    side("sdl_payable", totals.sdlMinor, "credit", "Skills development levy"),
    side("deductions_payable", totals.deductionsMinor + totals.employerContributionsMinor, "credit", "Deductions and fund contributions to pay over"),
    side("net_pay_clearing", totals.netPayMinor, "credit", "Net pay"),
  ].filter((line): line is LedgerLine => line !== null);
  return lines;
}

export interface RunForLedger {
  id: string;
  number: string;
  kind: "regular" | "correction" | "reversal";
  payDate: string;
  periodStart: string;
  periodEnd: string;
  totals: RunTotals;
  /** For a reversal: the run it reverses. */
  reversesRunId?: string | null;
}

export function ledgerPostFor(run: RunForLedger): LedgerPostRequested {
  const lines = payrollJournalLines(run.totals);
  if (!isBalanced(lines)) throw new PayrollError(`The journal for pay run ${run.number} does not balance`);
  const reversal = run.kind === "reversal";
  if (reversal && !run.reversesRunId) throw new PayrollError("A reversal run must name the run it reverses");
  return {
    key: ledgerKey(run.id),
    source: { plugin: PIB_PLUGINS.payroll, kind: reversal ? "pay_run_reversal" : "pay_run", id: run.id },
    date: run.payDate,
    memo: reversal
      ? `Reversal of pay run ${run.number}`
      : `Pay run ${run.number} (${run.periodStart} to ${run.periodEnd})`,
    currency: "ZAR",
    fxRate: null,
    lines,
    reverseKey: reversal ? ledgerKey(run.reversesRunId!) : null,
  };
}

export const LEDGER_POST_EVENT = LEDGER_EVENTS.postRequested;
