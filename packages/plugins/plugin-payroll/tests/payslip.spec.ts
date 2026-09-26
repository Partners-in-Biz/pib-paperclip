import { describe, expect, it } from "vitest";
import { calculatePeriod } from "../src/engine.js";
import { leaveBalances } from "../src/leave.js";
import { formatRand } from "../src/money.js";
import { payslipSpec, renderPayslip, type PayslipData } from "../src/payslip.js";
import { RULES_2026_27 } from "../src/seed.js";
import { ytdFor } from "../src/service/payslips.js";

const result = calculatePeriod({
  employeeId: "a",
  frequency: "monthly",
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  payDate: "2026-09-25",
  workerCategory: "salaried",
  rateMinor: 3_000_000,
  standardHoursCenti: 17_333,
  overtimeHoursCenti: 500,
  dateOfBirth: "1990-01-01",
  uifApplicable: true,
  sdlApplicable: true,
  medical: { members: 2, employeeContributionMinor: 250_000, employerContributionMinor: 150_000 },
  components: [{ code: "BONUS", amountMinor: 1_000_000 }],
}, RULES_2026_27);

const data: PayslipData = {
  number: "PR-2026-09-M01-E001",
  employer: { legalName: "Partners in Biz (Pty) Ltd", address: "1 Main Road, Ballito", payeReference: "7123456789" },
  employee: { name: "Thandi Nkosi", employeeNumber: "E001", jobTitle: "Designer", taxReferenceMask: "••••••789", bankName: "FNB", accountMask: "••••••5678" },
  run: { number: "PR-2026-09-M01", periodStart: "2026-09-01", periodEnd: "2026-09-30", payDate: "2026-09-25", taxYear: "2026/27", kind: "regular" },
  lines: result.lines,
  totals: result.totals,
  ytdByCode: { BASIC: 21_000_000, PAYE: 3_500_000 },
  ytd: { grossMinor: 22_000_000, taxableMinor: 21_500_000, payeMinor: 3_500_000, uifEmployeeMinor: 123_984, netMinor: 17_000_000 },
  leave: leaveBalances({ employmentStart: "2025-01-01", asOf: "2026-09-30", daysPerWeek: 5, requests: [] }),
};

describe("payslip", () => {
  it("renders a PDF", async () => {
    const pdf = await renderPayslip(data);
    expect(Buffer.from(pdf.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(1500);
  });

  it("shows earnings, deductions, net pay, YTD and leave, with masked numbers only", () => {
    const spec = payslipSpec(data);
    const text = JSON.stringify(spec);
    expect(spec.title).toBe("Payslip");
    expect(spec.rows!.map((r) => r.item)).toEqual([
      "EARNINGS", "Basic salary", "Overtime", "Bonus",
      "DEDUCTIONS", "Medical aid (employee contribution)", "PAYE (income tax)", "UIF (employee)",
    ]);
    expect(spec.rows!.find((r) => r.item === "Basic salary")!.ytd).toBe("R 210,000.00");
    expect(spec.totals!.find((t) => t.bold)!.value).toBe(formatRand(result.totals.netPayMinor));
    expect(text).toContain("Tax number ******789");
    expect(text).toContain("account ******5678");
    expect(text).toContain("Medical aid (employer contribution) (3810)");
    expect(text).toContain("Annual leave:");
    expect(text).not.toMatch(/62812345678|9001015009086|0123456789/);
  });

  it("builds year-to-date figures from locked items and the cut-over opening", () => {
    const posted = [
      { result: { lines: [{ code: "BASIC", amountMinor: 3_000_000 }, { code: "PAYE", amountMinor: 468_100 }] }, grossMinor: 3_000_000, taxableMinor: 3_000_000, payeMinor: 468_100, uifEmployeeMinor: 17_712, netMinor: 2_514_188 },
      { result: { lines: [{ code: "BASIC", amountMinor: 3_000_000 }, { code: "PAYE", amountMinor: 468_100 }] }, grossMinor: 3_000_000, taxableMinor: 3_000_000, payeMinor: 468_100, uifEmployeeMinor: 17_712, netMinor: 2_514_188 },
    ] as unknown as Parameters<typeof ytdFor>[0];
    const { byCode, ytd } = ytdFor(posted, { employeeId: "a", taxYear: "2026/27", codes: { "3699": 9_000_000 }, grossMinor: 9_000_000, payeMinor: 1_400_000, uifMinor: 0, sdlMinor: 0, etiMinor: 0 });
    expect(byCode.BASIC).toBe(6_000_000);
    expect(byCode.PAYE).toBe(936_200 + 1_400_000);
    expect(ytd).toEqual({ grossMinor: 15_000_000, taxableMinor: 15_000_000, payeMinor: 2_336_200, uifEmployeeMinor: 35_424, netMinor: 5_028_376 });
  });
});
