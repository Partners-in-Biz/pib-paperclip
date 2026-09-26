/**
 * Worked examples for the 2026/27 tax year (1 March 2026 – 28 February 2027).
 *
 * Every expected figure is worked by hand below from the SARS 2027 tables
 * (sources in src/seed.ts):
 *   brackets 18% to R245 100; R44 118 + 26% to R383 100; R79 998 + 31% to R530 200;
 *   R125 599 + 36% to R695 800; R185 215 + 39% to R887 000; R259 783 + 41% to R1 878 600;
 *   R666 339 + 45% above. Rebates R17 820 / R9 765 / R3 249. Medical credits R376 / R376 / R254.
 *   UIF 1% + 1% to R17 712 a month. SDL 1%. Retirement 27.5% capped at R430 000.
 *   Travel allowance 80% (20% at 80% business use). ETI bands from 1 April 2025.
 * Assumptions: monthly pay (12 periods) unless stated, a resident employee under 65
 * (DOB 1990-05-10) unless stated, no tax directive, cents rounded half up.
 */
import { describe, expect, it } from "vitest";
import { ageOn, calculateEti, calculatePeriod, etiFromBands, uifCeilingForPeriod, type PeriodInput } from "../src/engine.js";
import { bracketTax, checkRules, monthlyMedicalCredit, ruleVersionFor, taxYearBounds, taxYearOf } from "../src/rules.js";
import { RULES_2026_27 as R, RULE_VERSION_2026_27 } from "../src/seed.js";

function salaried(rateRand: number, extra: Partial<PeriodInput> = {}): PeriodInput {
  return {
    employeeId: "emp-1",
    frequency: "monthly",
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    payDate: "2026-09-25",
    workerCategory: "salaried",
    rateMinor: Math.round(rateRand * 100),
    standardHoursCenti: 17_333,
    dateOfBirth: "1990-05-10",
    uifApplicable: true,
    sdlApplicable: true,
    ...extra,
  };
}

describe("2026/27 rule version", () => {
  it("is internally consistent (brackets chain, thresholds match rebates)", () => {
    expect(checkRules(R)).toEqual([]);
  });

  it("is found by pay date and covers the tax year", () => {
    expect(ruleVersionFor([RULE_VERSION_2026_27], "2026-03-01")?.id).toBe("za-2026-27-v1");
    expect(ruleVersionFor([RULE_VERSION_2026_27], "2027-02-28")?.id).toBe("za-2026-27-v1");
    expect(ruleVersionFor([RULE_VERSION_2026_27], "2027-03-01")).toBeNull();
    expect(taxYearOf("2026-09-25")).toBe("2026/27");
    expect(taxYearOf("2027-02-01")).toBe("2026/27");
    expect(taxYearOf("2026-02-28")).toBe("2025/26");
    expect(taxYearBounds("2027/28")).toEqual({ startDate: "2027-03-01", endDate: "2028-02-29" });
  });

  it("taxes annual income through each bracket", () => {
    // R245 100 × 18% = R44 118 (top of bracket 1)
    expect(bracketTax(24_510_000, R)).toBe(4_411_800);
    // R1 000 000: 259 783 + 41% × 113 000 = 306 113
    expect(bracketTax(100_000_000, R)).toBe(30_611_300);
    expect(bracketTax(0, R)).toBe(0);
  });

  it("gives medical credits per member", () => {
    expect(monthlyMedicalCredit(R, 0)).toBe(0);
    expect(monthlyMedicalCredit(R, 1)).toBe(37_600);
    expect(monthlyMedicalCredit(R, 2)).toBe(75_200);
    expect(monthlyMedicalCredit(R, 4)).toBe(37_600 * 2 + 25_400 * 2);
  });
});

describe("PAYE across the brackets (monthly salary, primary rebate)", () => {
  // Annual = monthly × 12; tax from the table less R17 820; ÷ 12.
  const cases: Array<[string, number, number]> = [
    // R15 000 → R180 000 × 18% = 32 400 − 17 820 = 14 580 ÷ 12 = 1 215.00
    ["bracket 1", 15_000, 121_500],
    // R30 000 → R360 000: 44 118 + 26% × 114 900 = 73 992 − 17 820 = 56 172 ÷ 12 = 4 681.00
    ["bracket 2", 30_000, 468_100],
    // R40 000 → R480 000: 79 998 + 31% × 96 900 = 110 037 − 17 820 = 92 217 ÷ 12 = 7 684.75
    ["bracket 3", 40_000, 768_475],
    // R50 000 → R600 000: 125 599 + 36% × 69 800 = 150 727 − 17 820 = 132 907 ÷ 12 = 11 075.58
    ["bracket 4", 50_000, 1_107_558],
    // R65 000 → R780 000: 185 215 + 39% × 84 200 = 218 053 − 17 820 = 200 233 ÷ 12 = 16 686.08
    ["bracket 5", 65_000, 1_668_608],
    // R100 000 → R1 200 000: 259 783 + 41% × 313 000 = 388 113 − 17 820 = 370 293 ÷ 12 = 30 857.75
    ["bracket 6", 100_000, 3_085_775],
    // R200 000 → R2 400 000: 666 339 + 45% × 521 400 = 900 969 − 17 820 = 883 149 ÷ 12 = 73 595.75
    ["bracket 7", 200_000, 7_359_575],
  ];
  for (const [label, salary, paye] of cases) {
    it(`${label}: R${salary} a month`, () => {
      expect(calculatePeriod(salaried(salary), R).totals.payeMinor).toBe(paye);
    });
  }

  it("pays no PAYE at or below the R99 000 threshold", () => {
    // R8 250 × 12 = R99 000 → 17 820 − 17 820 = 0
    expect(calculatePeriod(salaried(8_250), R).totals.payeMinor).toBe(0);
    expect(calculatePeriod(salaried(8_000), R).totals.payeMinor).toBe(0);
    // R8 300 × 12 = R99 600 → 17 928 − 17 820 = 108 ÷ 12 = 9.00
    expect(calculatePeriod(salaried(8_300), R).totals.payeMinor).toBe(900);
  });

  it("works out the full R30 000 payslip", () => {
    const r = calculatePeriod(salaried(30_000), R);
    expect(r.totals).toMatchObject({
      grossMinor: 3_000_000,
      payeMinor: 468_100,
      // UIF 1% of the R17 712 ceiling = R177.12 each
      uifEmployeeMinor: 17_712,
      uifEmployerMinor: 17_712,
      // SDL 1% of R30 000
      sdlMinor: 30_000,
      // 30 000 − 4 681 − 177.12
      netPayMinor: 2_514_188,
      employerCostMinor: 3_000_000 + 17_712 + 30_000,
    });
    expect(r.sarsCodes).toMatchObject({ "3601": 3_000_000, "4102": 468_100, "4141": 35_424, "4142": 30_000 });
    expect(r.trace.map((t) => t.code)).toEqual(["rules", "ordinary", "taxable", "paye_regular", "uif", "sdl", "net"]);
  });
});

describe("age rebates (age on 28 February 2027)", () => {
  it("adds the secondary rebate from 65", () => {
    // 73 992 − (17 820 + 9 765) = 46 407 ÷ 12 = 3 867.25
    expect(calculatePeriod(salaried(30_000, { dateOfBirth: "1960-06-15" }), R).totals.payeMinor).toBe(386_725);
  });

  it("adds the tertiary rebate from 75", () => {
    // 73 992 − (17 820 + 9 765 + 3 249) = 43 158 ÷ 12 = 3 596.50
    expect(calculatePeriod(salaried(30_000, { dateOfBirth: "1952-02-28" }), R).totals.payeMinor).toBe(359_650);
  });

  it("uses the age reached by the last day of the tax year", () => {
    expect(ageOn("1962-02-28", "2027-02-28")).toBe(65);
    expect(ageOn("1962-03-01", "2027-02-28")).toBe(64);
    expect(calculatePeriod(salaried(30_000, { dateOfBirth: "1962-02-28" }), R).totals.payeMinor).toBe(386_725);
    expect(calculatePeriod(salaried(30_000, { dateOfBirth: "1962-03-01" }), R).totals.payeMinor).toBe(468_100);
  });
});

describe("medical scheme fees tax credit", () => {
  it("reduces PAYE and treats the employer contribution as a taxable benefit", () => {
    // Salary R30 000; main member + 2 dependants; employee pays R3 000, employer R2 000.
    // Taxable: 30 000 + 2 000 benefit = 32 000 → R384 000: 79 998 + 31% × 900 = 80 277 − 17 820 = 62 457.
    // Credit: 376 + 376 + 254 = 1 006 a month → 12 072 a year → 50 385 ÷ 12 = 4 198.75.
    const r = calculatePeriod(salaried(30_000, { medical: { members: 3, employeeContributionMinor: 300_000, employerContributionMinor: 200_000 } }), R);
    expect(r.totals.payeMinor).toBe(419_875);
    expect(r.totals.medicalCreditMinor).toBe(100_600);
    expect(r.totals.fringeBenefitsMinor).toBe(200_000);
    // SDL on 32 000 (the benefit is remuneration)
    expect(r.totals.sdlMinor).toBe(32_000);
    // Net: 30 000 − 4 198.75 − 177.12 − 3 000 = 22 624.13
    expect(r.totals.netPayMinor).toBe(2_262_413);
    // 4005 includes the employer's share (deemed paid); 4474 shows the employer's share.
    expect(r.sarsCodes).toMatchObject({ "3810": 200_000, "4005": 500_000, "4474": 200_000, "4116": 100_600 });
  });

  it("never makes PAYE negative", () => {
    // R9 000: 108 000 × 18% = 19 440 − 17 820 = 1 620 a year, less up to 12 072 credit → 0.
    const r = calculatePeriod(salaried(9_000, { medical: { members: 2, employeeContributionMinor: 150_000, employerContributionMinor: 0 } }), R);
    expect(r.totals.payeMinor).toBe(0);
    expect(r.totals.medicalCreditMinor).toBe(13_500); // only the 1 620 of tax could be offset: 1 620 ÷ 12 = 135
  });
});

describe("retirement-fund deduction", () => {
  it("deducts employee and employer contributions under the limits", () => {
    // Salary R30 000, pension 7.5% each side: R2 250 employee + R2 250 employer (taxable benefit).
    // Remuneration 32 250 → R387 000; contributions R54 000 < 27.5% (R106 425) and < R430 000.
    // Taxable R333 000: 44 118 + 26% × 87 900 = 66 972 − 17 820 = 49 152 ÷ 12 = 4 096.00.
    const r = calculatePeriod(salaried(30_000, { retirement: { fund: "pension", employeeContributionMinor: 225_000, employerContributionMinor: 225_000 } }), R);
    expect(r.totals.payeMinor).toBe(409_600);
    expect(r.totals.retirementDeductionMinor).toBe(450_000);
    // SDL on the balance after the deduction: (32 250 − 4 500) × 1% = 277.50
    expect(r.totals.sdlMinor).toBe(27_750);
    // Net: 30 000 − 4 096 − 177.12 − 2 250 = 23 476.88
    expect(r.totals.netPayMinor).toBe(2_347_688);
    expect(r.sarsCodes).toMatchObject({ "3817": 225_000, "4001": 450_000, "4472": 225_000 });
  });

  it("limits the deduction to 27.5% of remuneration", () => {
    // Salary R20 000 with a R6 000 retirement annuity through payroll.
    // Contributions R72 000 a year; 27.5% of R240 000 = R66 000 allowed.
    // Taxable R174 000 × 18% = 31 320 − 17 820 = 13 500 ÷ 12 = 1 125.00.
    const r = calculatePeriod(salaried(20_000, { retirement: { fund: "retirement_annuity", employeeContributionMinor: 600_000, employerContributionMinor: 0 } }), R);
    expect(r.totals.payeMinor).toBe(112_500);
    expect(r.totals.retirementDeductionMinor).toBe(550_000);
    expect(r.warnings.join(" ")).toMatch(/above the deductible limit/);
    expect(r.sarsCodes["4006"]).toBe(600_000);
  });

  it("limits the deduction to the R430 000 annual cap", () => {
    // Salary R200 000; employee R25 000 + employer R20 000 a month = R540 000 a year.
    // Remuneration R2 640 000 × 27.5% = R726 000, so the R430 000 cap applies.
    // Taxable R2 210 000: 666 339 + 45% × 331 400 = 815 469 − 17 820 = 797 649 ÷ 12 = 66 470.75.
    const r = calculatePeriod(salaried(200_000, { retirement: { fund: "provident", employeeContributionMinor: 2_500_000, employerContributionMinor: 2_000_000 } }), R);
    expect(r.totals.payeMinor).toBe(6_647_075);
    expect(r.sarsCodes).toMatchObject({ "3825": 2_000_000, "4003": 4_500_000, "4473": 2_000_000 });
  });
});

describe("travel allowance", () => {
  it("includes 80% for PAYE", () => {
    // R30 000 + R5 000 allowance; taxable 30 000 + 4 000 = 34 000 → R408 000:
    // 79 998 + 31% × 24 900 = 87 717 − 17 820 = 69 897 ÷ 12 = 5 824.75.
    const r = calculatePeriod(salaried(30_000, { travelAllowance: { amountMinor: 500_000, businessUseAtLeast80: false } }), R);
    expect(r.totals.payeMinor).toBe(582_475);
    expect(r.totals.grossMinor).toBe(3_500_000);
    expect(r.totals.sdlMinor).toBe(34_000);
    expect(r.totals.netPayMinor).toBe(3_500_000 - 582_475 - 17_712);
    expect(r.sarsCodes["3701"]).toBe(500_000);
  });

  it("includes 20% when business use is at least 80%", () => {
    // Taxable 30 000 + 1 000 = 31 000 → R372 000: 44 118 + 26% × 126 900 = 77 112 − 17 820 = 59 292 ÷ 12 = 4 941.00.
    const r = calculatePeriod(salaried(30_000, { travelAllowance: { amountMinor: 500_000, businessUseAtLeast80: true } }), R);
    expect(r.totals.payeMinor).toBe(494_100);
  });
});

describe("bonus (irregular payment, not annualised)", () => {
  it("taxes the bonus as tax with it minus tax without it", () => {
    // Regular R360 000 → 56 172. With the R30 000 bonus: R390 000: 79 998 + 31% × 6 900 = 82 137 − 17 820 = 64 317.
    // Bonus PAYE 64 317 − 56 172 = 8 145; total 4 681 + 8 145 = 12 826.
    const r = calculatePeriod(salaried(30_000, { components: [{ code: "BONUS", amountMinor: 3_000_000 }] }), R);
    expect(r.totals.payeMinor).toBe(1_282_600);
    expect(r.totals.irregularTaxableMinor).toBe(3_000_000);
    expect(r.totals.sdlMinor).toBe(60_000);
    expect(r.totals.netPayMinor).toBe(6_000_000 - 1_282_600 - 17_712);
    expect(r.sarsCodes["3605"]).toBe(3_000_000);
    expect(r.trace.some((t) => t.code === "paye_irregular")).toBe(true);
  });
});

describe("UIF", () => {
  it("caps at R177.12 a month", () => {
    expect(calculatePeriod(salaried(100_000), R).totals.uifEmployeeMinor).toBe(17_712);
    // Under the ceiling: R10 000 → R100
    expect(calculatePeriod(salaried(10_000), R).totals.uifEmployeeMinor).toBe(10_000);
  });

  it("scales the ceiling for weekly and fortnightly pay", () => {
    // 17 712 × 12 ÷ 52 = 4 087.38; ÷ 26 → 8 174.77
    expect(uifCeilingForPeriod(R, "weekly")).toBe(408_738);
    expect(uifCeilingForPeriod(R, "fortnightly")).toBe(817_477);
    const weekly = calculatePeriod(salaried(6_000, { frequency: "weekly", standardHoursCenti: 4_000, periodStart: "2026-09-07", periodEnd: "2026-09-13", payDate: "2026-09-11" }), R);
    expect(weekly.totals.uifEmployeeMinor).toBe(4_087);
  });

  it("leaves commission out of UIF", () => {
    // R10 000 salary + R10 000 commission: UIF on R10 000 only; PAYE and SDL on R20 000.
    const r = calculatePeriod(salaried(10_000, { components: [{ code: "COMMISSION", amountMinor: 1_000_000 }] }), R);
    expect(r.totals.uifEmployeeMinor).toBe(10_000);
    expect(r.totals.sdlMinor).toBe(20_000);
    expect(r.sarsCodes["3606"]).toBe(1_000_000);
  });

  it("does not apply when the employee is exempt", () => {
    const r = calculatePeriod(salaried(10_000, { uifApplicable: false }), R);
    expect(r.totals.uifEmployeeMinor).toBe(0);
    expect(r.totals.uifEmployerMinor).toBe(0);
  });
});

describe("SDL", () => {
  it("is employer-only and skipped when the employer is exempt", () => {
    const exempt = calculatePeriod(salaried(30_000, { sdlApplicable: false }), R);
    expect(exempt.totals.sdlMinor).toBe(0);
    expect(exempt.totals.netPayMinor).toBe(2_514_188);
  });
});

describe("fortnightly pay", () => {
  it("annualises over 26 periods", () => {
    // R14 000 × 26 = R364 000: 44 118 + 26% × 118 900 = 75 032 − 17 820 = 57 212 ÷ 26 = 2 200.46
    const r = calculatePeriod(salaried(14_000, { frequency: "fortnightly", standardHoursCenti: 8_000, periodStart: "2026-09-01", periodEnd: "2026-09-14", payDate: "2026-09-15" }), R);
    expect(r.totals.payeMinor).toBe(220_046);
    // UIF 1% of the R8 174.77 fortnightly ceiling = R81.75
    expect(r.totals.uifEmployeeMinor).toBe(8_175);
  });
});

describe("hours, overtime and unpaid leave", () => {
  it("pays hourly wages and overtime at 1.5×", () => {
    // R100/h × 160 h = 16 000; 10 h × R150 = 1 500; gross 17 500 → R210 000 × 18% = 37 800 − 17 820 = 19 980 ÷ 12 = 1 665.
    const r = calculatePeriod({ ...salaried(0), workerCategory: "hourly", rateMinor: 10_000, ordinaryHoursCenti: 16_000, overtimeHoursCenti: 1_000, overtimeMultiplierBp: 15_000 }, R);
    expect(r.totals.grossMinor).toBe(1_750_000);
    expect(r.totals.payeMinor).toBe(166_500);
    expect(r.totals.uifEmployeeMinor).toBe(17_500);
    expect(r.totals.netPayMinor).toBe(1_750_000 - 166_500 - 17_500);
    expect(r.sarsCodes["3607"]).toBe(150_000);
  });

  it("deducts unpaid leave from a salary", () => {
    // R20 000 over 160 h; 8 h unpaid = R1 000 off → R19 000: R228 000 × 18% = 41 040 − 17 820 = 23 220 ÷ 12 = 1 935.
    const r = calculatePeriod(salaried(20_000, { standardHoursCenti: 16_000, unpaidLeaveHoursCenti: 800 }), R);
    expect(r.totals.grossMinor).toBe(1_900_000);
    expect(r.totals.payeMinor).toBe(193_500);
    expect(r.lines.find((l) => l.code === "LEAVE_UNPAID")?.amountMinor).toBe(-100_000);
    expect(r.sarsCodes["3601"]).toBe(1_900_000);
  });

  it("refuses a period that would pay a negative net", () => {
    expect(() => calculatePeriod(salaried(5_000, { components: [{ code: "STAFF_LOAN", amountMinor: 600_000 }] }), R)).toThrow(/negative/);
  });

  it("refuses a pay date outside the tax year", () => {
    expect(() => calculatePeriod(salaried(5_000, { payDate: "2027-03-25" }), R)).toThrow(/outside tax year/);
  });

  it("flags pay below the national minimum wage", () => {
    // R4 000 for 160 hours = R25/h < R30.23/h
    const r = calculatePeriod(salaried(4_000, { standardHoursCenti: 16_000 }), R);
    expect(r.hours.belowMinimumWage).toBe(true);
    expect(calculatePeriod(salaried(6_000, { standardHoursCenti: 16_000 }), R).hours.belowMinimumWage).toBe(false);
  });
});

describe("Employment Tax Incentive (bands from 1 April 2025)", () => {
  it("follows the band table", () => {
    // 60% under R2 500; R1 500 flat to R5 499.99; R1 500 − 0.75 × (R − 5 500) to R7 499.99; nil from R7 500.
    expect(etiFromBands(R.eti.firstYear, 200_000)).toBe(120_000);
    expect(etiFromBands(R.eti.firstYear, 400_000)).toBe(150_000);
    expect(etiFromBands(R.eti.firstYear, 600_000)).toBe(112_500);
    expect(etiFromBands(R.eti.firstYear, 750_000)).toBe(0);
    expect(etiFromBands(R.eti.secondYear, 200_000)).toBe(60_000);
    expect(etiFromBands(R.eti.secondYear, 400_000)).toBe(75_000);
    // 750 − 0.375 × 500 = 562.50
    expect(etiFromBands(R.eti.secondYear, 600_000)).toBe(56_250);
  });

  it("grosses up part-time hours and pro-rates", () => {
    // R2 000 for 60 hours (R33.33/h): grossed up to 160 h = R5 333.33 → R1 500 × 60/160 = R562.50
    const result = calculateEti({ rules: R, eligible: true, ageAtMonthEnd: 22, qualifyingMonth: 1, monthlyRemunerationMinor: 200_000, hoursWorkedCenti: 6_000 });
    expect(result.grossedUpMinor).toBe(533_333);
    expect(result.etiMinor).toBe(56_250);
  });

  it("stops outside ages 18–29, after 24 months and below the minimum wage", () => {
    const base = { rules: R, eligible: true, ageAtMonthEnd: 22, qualifyingMonth: 1, monthlyRemunerationMinor: 500_000, hoursWorkedCenti: 16_000 };
    expect(calculateEti(base).etiMinor).toBe(150_000);
    expect(calculateEti({ ...base, qualifyingMonth: 13 }).etiMinor).toBe(75_000);
    expect(calculateEti({ ...base, qualifyingMonth: 25 }).etiMinor).toBe(0);
    expect(calculateEti({ ...base, ageAtMonthEnd: 30 }).etiMinor).toBe(0);
    expect(calculateEti({ ...base, ageAtMonthEnd: 17 }).etiMinor).toBe(0);
    // R4 000 for 160 h = R25/h, below R30.23
    expect(calculateEti({ ...base, monthlyRemunerationMinor: 400_000 }).reason).toMatch(/minimum wage/);
    expect(calculateEti({ ...base, eligible: false }).etiMinor).toBe(0);
  });

  it("is worked out in a monthly pay run", () => {
    // R6 000 salary, 173.33 standard hours, age 22, qualifying month 3 → R1 125.
    // PAYE on R72 000 a year is nil, so the ETI carries forward (it never changes net pay).
    const r = calculatePeriod(salaried(6_000, { dateOfBirth: "2004-05-01", eti: { eligible: true, qualifyingMonth: 3 } }), R);
    expect(r.totals.etiMinor).toBe(112_500);
    expect(r.totals.payeMinor).toBe(0);
    expect(r.totals.netPayMinor).toBe(600_000 - 6_000);
    expect(r.sarsCodes["4118"]).toBe(112_500);
  });
});

describe("determinism and privacy", () => {
  it("gives the same result for the same input", () => {
    const input = salaried(42_500, { medical: { members: 2, employeeContributionMinor: 250_000, employerContributionMinor: 0 }, components: [{ code: "BONUS", amountMinor: 1_000_000 }] });
    expect(JSON.stringify(calculatePeriod(input, R))).toBe(JSON.stringify(calculatePeriod(input, R)));
  });

  it("keeps the trace to amounts and codes", () => {
    const r = calculatePeriod(salaried(30_000), R);
    const text = JSON.stringify(r.trace);
    expect(text).not.toMatch(/1990-05-10/);
    for (const step of r.trace) {
      for (const value of [...Object.values(step.inputs), ...Object.values(step.outputs)]) {
        expect(["number", "string", "boolean"].includes(typeof value) || value === null).toBe(true);
      }
    }
  });
});
