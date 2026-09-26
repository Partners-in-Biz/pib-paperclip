import { isBalanced, LEDGER_SOURCES } from "@partnersinbiz/pib-plugin-kit";
import { describe, expect, it } from "vitest";
import { calculatePeriod } from "../src/engine.js";
import { EMPTY_RUN_TOTALS, etiUsed, ledgerKey, ledgerPostFor, payrollJournalLines, type RunTotals } from "../src/ledger.js";
import { RULES_2026_27 } from "../src/seed.js";

function totalsFrom(results: ReturnType<typeof calculatePeriod>[]): RunTotals {
  const t = { ...EMPTY_RUN_TOTALS };
  for (const r of results) {
    t.employeeCount += 1;
    t.grossMinor += r.totals.grossMinor;
    t.fringeBenefitsMinor += r.totals.fringeBenefitsMinor;
    t.payeMinor += r.totals.payeMinor;
    t.etiMinor += r.totals.etiMinor;
    t.uifEmployeeMinor += r.totals.uifEmployeeMinor;
    t.uifEmployerMinor += r.totals.uifEmployerMinor;
    t.sdlMinor += r.totals.sdlMinor;
    t.deductionsMinor += r.totals.deductionsMinor;
    t.employerContributionsMinor += r.totals.employerContributionsMinor;
    t.netPayMinor += r.totals.netPayMinor;
    t.employerCostMinor += r.totals.employerCostMinor;
  }
  return t;
}

const base = {
  frequency: "monthly" as const,
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  payDate: "2026-09-25",
  workerCategory: "salaried" as const,
  standardHoursCenti: 17_333,
  uifApplicable: true,
  sdlApplicable: true,
};

const results = [
  calculatePeriod({ ...base, employeeId: "a", rateMinor: 3_000_000, dateOfBirth: "1990-01-01", medical: { members: 2, employeeContributionMinor: 250_000, employerContributionMinor: 150_000 }, retirement: { fund: "pension", employeeContributionMinor: 225_000, employerContributionMinor: 225_000 }, components: [{ code: "BONUS", amountMinor: 1_000_000 }, { code: "STAFF_LOAN", amountMinor: 50_000 }] }, RULES_2026_27),
  calculatePeriod({ ...base, employeeId: "b", rateMinor: 600_000, dateOfBirth: "2004-05-01", eti: { eligible: true, qualifyingMonth: 1 } }, RULES_2026_27),
  calculatePeriod({ ...base, employeeId: "c", rateMinor: 1_200_000, dateOfBirth: "2003-01-01", eti: { eligible: true, qualifyingMonth: 2 }, travelAllowance: { amountMinor: 200_000, businessUseAtLeast80: false } }, RULES_2026_27),
];
const totals = totalsFrom(results);

describe("pay run journal", () => {
  it("balances and uses only the agreed account roles", () => {
    const lines = payrollJournalLines({ ...totals, etiMinor: 0 });
    expect(isBalanced(lines)).toBe(true);
    const roles = lines.map((l) => l.role);
    expect(roles).toEqual(["salaries", "employer_contributions", "paye_payable", "uif_payable", "sdl_payable", "deductions_payable", "net_pay_clearing"]);
    const debit = lines.reduce((s, l) => s + l.debitMinor, 0);
    // Debits are the full cost to company.
    expect(debit).toBe(totals.employerCostMinor);
    const byRole = Object.fromEntries(lines.map((l) => [l.role, l.creditMinor || l.debitMinor]));
    expect(byRole.net_pay_clearing).toBe(totals.netPayMinor);
    expect(byRole.uif_payable).toBe(totals.uifEmployeeMinor + totals.uifEmployerMinor);
    expect(byRole.deductions_payable).toBe(totals.deductionsMinor + totals.employerContributionsMinor);
  });

  it("takes ETI off PAYE payable, never more than the PAYE", () => {
    // Employee c earns R12 000 (above the R7 500 ETI ceiling), so only b earns ETI (R1 125 at R6 000).
    expect(totals.etiMinor).toBe(112_500);
    expect(etiUsed({ payeMinor: 50_000, etiMinor: 112_500 })).toBe(50_000);
    const withEti = totals;
    const lines = payrollJournalLines(withEti);
    expect(lines.map((l) => l.role)).toContain("revenue:employment_tax_incentive");
    expect(isBalanced(lines)).toBe(true);
    const eti = lines.find((l) => l.role === "revenue:employment_tax_incentive")!;
    expect(eti.creditMinor).toBe(112_500);
    expect(lines.find((l) => l.role === "paye_payable")!.creditMinor).toBe(withEti.payeMinor - 112_500);
  });

  it("mirrors the journal for a reversal (negated totals)", () => {
    const negated = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, k === "employeeCount" ? v : -v])) as unknown as RunTotals;
    const original = payrollJournalLines(totals);
    const reversal = payrollJournalLines(negated);
    expect(isBalanced(reversal)).toBe(true);
    expect(reversal.map((l) => [l.role, l.debitMinor, l.creditMinor])).toEqual(original.map((l) => [l.role, l.creditMinor, l.debitMinor]));
  });

  it("builds the ledger.post.requested payload with the outbox key and source", () => {
    const post = ledgerPostFor({ id: "run_1", number: "PR-2026-09-M01", kind: "regular", payDate: "2026-09-25", periodStart: "2026-09-01", periodEnd: "2026-09-30", totals });
    expect(post.key).toBe("payroll:run:run_1");
    expect(post.source).toEqual({ plugin: "partnersinbiz.payroll", kind: "pay_run", id: "run_1" });
    expect(LEDGER_SOURCES).toContain(post.source.plugin);
    expect(post.currency).toBe("ZAR");
    expect(post.date).toBe("2026-09-25");
    expect(post.reverseKey).toBeNull();
    expect(isBalanced(post.lines)).toBe(true);
  });

  it("points a reversal at the original journal", () => {
    const negated = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, k === "employeeCount" ? v : -v])) as unknown as RunTotals;
    const post = ledgerPostFor({ id: "run_2", number: "RV-2026-10-M01", kind: "reversal", payDate: "2026-10-02", periodStart: "2026-09-01", periodEnd: "2026-09-30", totals: negated, reversesRunId: "run_1" });
    expect(post.reverseKey).toBe(ledgerKey("run_1"));
    expect(post.source.kind).toBe("pay_run_reversal");
    expect(() => ledgerPostFor({ id: "x", number: "RV", kind: "reversal", payDate: "2026-10-02", periodStart: "2026-09-01", periodEnd: "2026-09-30", totals: negated })).toThrow(/must name/);
  });

  it("refuses an empty run", () => {
    expect(() => ledgerPostFor({ id: "e", number: "PR", kind: "regular", payDate: "2026-09-25", periodStart: "2026-09-01", periodEnd: "2026-09-30", totals: EMPTY_RUN_TOTALS })).toThrow(/does not balance/);
  });
});
