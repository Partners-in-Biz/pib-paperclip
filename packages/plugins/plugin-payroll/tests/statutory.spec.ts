import { describe, expect, it } from "vitest";
import { parseRandToMinor } from "../src/money.js";
import { RULES_2026_27 as R } from "../src/seed.js";
import {
  buildCertificate,
  buildEmp201,
  buildEmp501,
  certificatesCsv,
  emp201Csv,
  emp201DueDate,
  isDeductionCode,
  parseCsv,
  parseYtdCsv,
  saPublicHolidays,
  taxYearMonths,
  type StatutoryItem,
} from "../src/statutory.js";

function item(patch: Partial<StatutoryItem> & { employeeId: string; payDate: string }): StatutoryItem {
  return {
    runId: patch.runId ?? "run-1",
    runNumber: patch.runNumber ?? "PR-2026-09-M01",
    runKind: patch.runKind ?? "regular",
    frequency: patch.frequency ?? "monthly",
    hoursCenti: patch.hoursCenti ?? 17_333,
    belowMinimumWage: patch.belowMinimumWage ?? false,
    ...patch,
    totals: {
      grossMinor: 0, payeMinor: 0, uifEmployeeMinor: 0, uifEmployerMinor: 0, sdlMinor: 0, etiMinor: 0, regularTaxableMinor: 0, irregularTaxableMinor: 0, netPayMinor: 0,
      ...(patch.totals ?? {}),
    },
    sarsCodes: patch.sarsCodes ?? {},
  };
}

describe("EMP201", () => {
  const items = [
    item({ employeeId: "a", payDate: "2026-09-25", totals: { grossMinor: 3_000_000, payeMinor: 468_100, uifEmployeeMinor: 17_712, uifEmployerMinor: 17_712, sdlMinor: 30_000, etiMinor: 0, regularTaxableMinor: 3_000_000, irregularTaxableMinor: 0, netPayMinor: 2_514_188 } }),
    item({ employeeId: "b", payDate: "2026-09-25", totals: { grossMinor: 600_000, payeMinor: 0, uifEmployeeMinor: 6_000, uifEmployerMinor: 6_000, sdlMinor: 6_000, etiMinor: 112_500, regularTaxableMinor: 600_000, irregularTaxableMinor: 0, netPayMinor: 594_000 } }),
    item({ employeeId: "a", payDate: "2026-08-25", totals: { grossMinor: 1, payeMinor: 999, uifEmployeeMinor: 0, uifEmployerMinor: 0, sdlMinor: 0, etiMinor: 0, regularTaxableMinor: 0, irregularTaxableMinor: 0, netPayMinor: 0 } }),
  ];

  it("totals the month's PAYE, SDL and UIF and takes ETI off PAYE", () => {
    const e = buildEmp201({ month: "2026-09", items, rules: R });
    expect(e).toMatchObject({
      employees: 2,
      payeMinor: 468_100,
      sdlMinor: 36_000,
      uifMinor: 47_424,
      etiCalculatedMinor: 112_500,
      etiUsedMinor: 112_500,
      etiCarriedForwardMinor: 0,
      payeAfterEtiMinor: 355_600,
      totalPayableMinor: 355_600 + 36_000 + 47_424,
      dueDate: "2026-10-07",
    });
  });

  it("carries unused ETI forward and never takes PAYE below zero", () => {
    const e = buildEmp201({ month: "2026-09", items: [items[1]!], rules: R, etiBroughtForwardMinor: 20_000 });
    expect(e.etiUsedMinor).toBe(0);
    expect(e.etiCarriedForwardMinor).toBe(132_500);
    expect(e.payeAfterEtiMinor).toBe(0);
  });

  it("drops the month's ETI when anyone is paid below the minimum wage (SARS Budget 2026 FAQ)", () => {
    const below = item({ employeeId: "c", payDate: "2026-09-25", belowMinimumWage: true, totals: { grossMinor: 400_000, payeMinor: 0, uifEmployeeMinor: 4_000, uifEmployerMinor: 4_000, sdlMinor: 4_000, etiMinor: 0, regularTaxableMinor: 400_000, irregularTaxableMinor: 0, netPayMinor: 396_000 } });
    const e = buildEmp201({ month: "2026-09", items: [...items, below], rules: R });
    expect(e.etiCalculatedMinor).toBe(0);
    expect(e.notes.join(" ")).toMatch(/minimum wage/);
  });

  it("works out ETI for weekly staff on the month's total", () => {
    // Four weekly pays of R1 250 for 40 hours: R5 000 for 160 hours (R31.25/h) → R1 500 in qualifying month 1.
    const weekly = ["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25"].map((payDate, i) =>
      item({ employeeId: "w", payDate, runId: `w${i}`, frequency: "weekly", hoursCenti: 4_000, totals: { grossMinor: 125_000, payeMinor: 0, uifEmployeeMinor: 1_250, uifEmployerMinor: 1_250, sdlMinor: 0, etiMinor: 0, regularTaxableMinor: 125_000, irregularTaxableMinor: 0, netPayMinor: 123_750 } }));
    const e = buildEmp201({ month: "2026-09", items: weekly, rules: R, etiEmployees: [{ employeeId: "w", eligible: true, dateOfBirth: "2003-01-01", qualifyingMonth: 1 }] });
    expect(e.etiCalculatedMinor).toBe(150_000);
  });

  it("is due on the 7th, or the last business day before", () => {
    expect(emp201DueDate("2026-09")).toBe("2026-10-07");
    // 7 March 2026 is a Saturday → Friday 6 March
    expect(emp201DueDate("2026-02")).toBe("2026-03-06");
    // 7 February 2027 is a Sunday → Friday 5 February
    expect(emp201DueDate("2027-01")).toBe("2027-02-05");
    // Good Friday 7 April 2023 → Thursday 6 April
    expect(emp201DueDate("2023-03")).toBe("2023-04-06");
    expect(saPublicHolidays(2026).has("2026-04-03")).toBe(true); // Good Friday 2026
    expect(saPublicHolidays(2026).has("2026-04-06")).toBe(true); // Family Day 2026
  });

  it("writes an evidence CSV", () => {
    const csv = emp201Csv(buildEmp201({ month: "2026-09", items, rules: R }), { legalName: "PiB", payeReference: "7123456789", sdlReference: "L123", uifReference: "U123" });
    expect(csv).toContain("PAYE,4681.00");
    expect(csv).toContain("ETI used,1125.00");
    expect(csv).toContain("Total payable,4390.24");
    expect(csv).toContain("not submitted to SARS");
  });

  it("lists the tax year's months", () => {
    expect(taxYearMonths("2026/27")).toEqual(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"]);
    expect(taxYearMonths("2026/27", "interim")).toHaveLength(6);
  });
});

describe("IRP5 / IT3(a)", () => {
  const employee = { employeeId: "a", employeeNumber: "E001", firstName: "Thandi", lastName: "Nkosi", dateOfBirth: "1990-01-01", startDate: "2025-01-01", endDate: null };
  const months = ["2026-03-25", "2026-04-24"].map((payDate) =>
    item({ employeeId: "a", payDate, sarsCodes: { "3601": 3_000_000, "3810": 150_000, "4001": 450_000, "4005": 400_000, "4474": 150_000, "4102": 419_875, "4116": 75_200, "4141": 35_424, "4142": 31_500 } }));

  it("sums source codes and derives 3699, 4497 and 4149", () => {
    const cert = buildCertificate({ employee, taxYear: "2026/27", items: months });
    expect(cert.kind).toBe("IRP5");
    expect(cert.codes["3601"]).toBe(6_000_000);
    // 3699 = taxable income codes (3601 + 3810)
    expect(cert.codes["3699"]).toBe(6_300_000);
    // 4497 = all 40xx and 44xx (4001 + 4005 + 4474); 4116 and 4102 are not deductions
    expect(cert.codes["4497"]).toBe(2 * (450_000 + 400_000 + 150_000));
    // 4149 = 4102 + 4141 + 4142
    expect(cert.codes["4149"]).toBe(2 * (419_875 + 35_424 + 31_500));
    expect(cert.periodStart).toBe("2026-03-01");
    expect(cert.payPeriods).toBe(1);
    expect(isDeductionCode("4116")).toBe(false);
    expect(isDeductionCode("4474")).toBe(true);
  });

  it("adds the cut-over opening and caps 4118 at 75% of 3699", () => {
    const low = [item({ employeeId: "a", payDate: "2026-09-25", sarsCodes: { "3601": 100_000, "4118": 150_000 } })];
    const cert = buildCertificate({ employee, taxYear: "2026/27", items: low, ytd: { employeeId: "a", taxYear: "2026/27", codes: { "3601": 50_000 }, payeMinor: 0, uifMinor: 0, sdlMinor: 0, etiMinor: 0, grossMinor: 50_000 } });
    expect(cert.includesOpening).toBe(true);
    expect(cert.codes["3601"]).toBe(150_000);
    expect(cert.codes["4118"]).toBe(112_500);
    expect(cert.kind).toBe("IT3(a)");
    expect(cert.reasonCode).toBe("02");
  });

  it("counts a reversal against the original", () => {
    const reversal = item({ employeeId: "a", payDate: "2026-05-02", runKind: "reversal", runId: "rv", sarsCodes: { "3601": -3_000_000, "4102": -419_875 } });
    const cert = buildCertificate({ employee, taxYear: "2026/27", items: [...months, reversal] });
    expect(cert.codes["3601"]).toBe(3_000_000);
    expect(cert.payeMinor).toBe(419_875);
  });

  it("exports one row per employee per code", () => {
    const cert = buildCertificate({ employee, taxYear: "2026/27", items: months });
    const csv = certificatesCsv([cert], [{ ...employee, idNumber: "9001015009086", taxReference: "0123456789" }]);
    const rows = parseCsv(csv);
    expect(rows[0]![0]).toBe("Tax year");
    const paye = rows.find((r) => r[14] === "4102")!;
    expect(paye.slice(0, 5)).toEqual(["2026/27", "IRP5", "E001", "Nkosi", "Thandi"]);
    expect(paye[15]).toBe("8397.50");
  });
});

describe("EMP501", () => {
  it("reconciles EMP201 totals with certificates, including cut-over openings", () => {
    const employee = { employeeId: "a", employeeNumber: "E001", firstName: "T", lastName: "N", dateOfBirth: null, startDate: "2020-01-01", endDate: null };
    const items = [item({ employeeId: "a", payDate: "2026-09-25", totals: { grossMinor: 0, payeMinor: 468_100, uifEmployeeMinor: 17_712, uifEmployerMinor: 17_712, sdlMinor: 30_000, etiMinor: 0, regularTaxableMinor: 0, irregularTaxableMinor: 0, netPayMinor: 0 }, sarsCodes: { "4102": 468_100, "4141": 35_424, "4142": 30_000 } })];
    const month = buildEmp201({ month: "2026-09", items, rules: R });
    const ytd = { employeeId: "a", taxYear: "2026/27", codes: { "4102": 2_000_000, "4141": 200_000, "4142": 150_000 }, payeMinor: 2_000_000, uifMinor: 200_000, sdlMinor: 150_000, etiMinor: 0, grossMinor: 0 };
    const cert = buildCertificate({ employee, taxYear: "2026/27", items, ytd });
    const without = buildEmp501("2026/27", "annual", [month], [cert]);
    expect(without.reconciled).toBe(false);
    expect(without.difference.payeMinor).toBe(-2_000_000);
    const withOpening = buildEmp501("2026/27", "annual", [month], [cert], { payeMinor: 2_000_000, sdlMinor: 150_000, uifMinor: 200_000, etiMinor: 0 });
    expect(withOpening.reconciled).toBe(true);
    expect(withOpening.certificates).toMatchObject({ count: 1, irp5: 1, it3a: 0 });
  });
});

describe("YTD import", () => {
  it("reads employee numbers and SARS code columns in rand", () => {
    const { rows, errors } = parseYtdCsv('employee_number,3601,3605,4102,4141,4142,eti\nE001,"150 000,00",10000,21000.50,885.60,1500,0\n,1,1,1,1,1,1\nE002,abc,1,1,1,1,1', parseRandToMinor);
    expect(rows[0]).toEqual({ employeeNumber: "E001", codes: { "3601": 15_000_000, "3605": 1_000_000, "4102": 2_100_050, "4141": 88_560, "4142": 150_000 }, payeMinor: 2_100_050, uifMinor: 88_560, sdlMinor: 150_000, etiMinor: 0, grossMinor: 16_000_000 });
    expect(errors).toEqual(["Row 3: employee number is empty", 'Row 4: 3601 "abc" is not an amount']);
  });

  it("parses rand amounts safely", () => {
    expect(parseRandToMinor("R 1 234,50")).toBe(123_450);
    expect(parseRandToMinor("1,234.50")).toBe(123_450);
    expect(parseRandToMinor("(12.30)")).toBe(-1_230);
    expect(parseRandToMinor("12.345")).toBeNull();
    expect(parseRandToMinor("")).toBeNull();
  });
});
