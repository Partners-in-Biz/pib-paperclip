/**
 * South African payroll calculation for one employee and one pay period.
 *
 * Pure: no I/O, no clock, no personal details. Every figure comes from the
 * rule version passed in, and every step is written to a trace an
 * accountant can follow. Ported from the old platform's
 * `lib/payroll/calculation.ts` (annualised PAYE with rebates, UIF capped,
 * SDL, overtime, bonus, commission, unpaid leave) and extended with the
 * SARS irregular-payment method for bonuses, medical scheme fees tax
 * credits, the retirement-fund deduction cap, travel allowances and the
 * Employment Tax Incentive.
 *
 * PAYE method (SARS "annual equivalent"):
 * 1. Regular taxable remuneration for the period × periods per year.
 * 2. Less retirement-fund contributions (employee + employer), limited to
 *    27.5% of that remuneration and the annual cap.
 * 3. Tax from the brackets, less rebates for the age reached by the end of
 *    the tax year, less the medical scheme fees tax credit (annualised);
 *    never below zero. Divided by periods per year.
 * 4. Irregular payments (bonus): tax on (annual equivalent + payment) minus
 *    tax on the annual equivalent, all in this period.
 */
import { componentByCode, DEFAULT_COMPONENTS, SYSTEM_CODES, type ComponentDefinition, type ComponentKind } from "./components.js";
import { applyBp, divRound, PayrollError, timesHours } from "./money.js";
import { annualRebate, bracketTax, monthlyMedicalCredit, type EtiBand, type PayFrequency, type PayrollRules } from "./rules.js";

export type WorkerCategory = "salaried" | "hourly";
export type RetirementFund = "pension" | "provident" | "retirement_annuity";

export interface ComponentAmount {
  code: string;
  /** Amount for this period in cents (positive; deductions are subtracted by kind). */
  amountMinor: number;
  /** Shown on the payslip; defaults to the component's name. */
  label?: string | null;
}

export interface PeriodInput {
  employeeId: string;
  frequency: PayFrequency;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  workerCategory: WorkerCategory;
  /** Salary for the period (salaried) or rate per hour (hourly), cents. */
  rateMinor: number;
  /** Normal hours in the period (salaried), centi-hours; used for hourly equivalents. */
  standardHoursCenti: number;
  /** Hours worked at the ordinary rate (hourly workers), centi-hours. */
  ordinaryHoursCenti?: number;
  overtimeHoursCenti?: number;
  /** Overtime multiplier in basis points (1.5× = 15000). */
  overtimeMultiplierBp?: number;
  /** Sunday / public holiday hours paid at double time, centi-hours. */
  doubleTimeHoursCenti?: number;
  /** Approved unpaid leave in the period, centi-hours. */
  unpaidLeaveHoursCenti?: number;
  /** Approved paid leave (hourly workers only; salaried pay already covers it), centi-hours. */
  paidLeaveHoursCenti?: number;
  /** Date of birth (YYYY-MM-DD), for the age rebates. */
  dateOfBirth?: string | null;
  uifApplicable: boolean;
  /** The employer pays SDL this period (registered and not exempt). */
  sdlApplicable: boolean;
  medical?: { members: number; employeeContributionMinor: number; employerContributionMinor: number } | null;
  retirement?: { fund: RetirementFund; employeeContributionMinor: number; employerContributionMinor: number } | null;
  travelAllowance?: { amountMinor: number; businessUseAtLeast80: boolean } | null;
  components?: ComponentAmount[];
  eti?: {
    /** The employee qualifies (valid ID, age, not connected, and the employer is registered). */
    eligible: boolean;
    /**
     * This month's number among the months ETI has been claimed for the
     * employee (1 = first). SARS counts only months that qualified; the caller
     * counts earlier claims, including months claimed before cut-over.
     */
    qualifyingMonth: number;
    /** Ordinary hours worked in the month, centi-hours; defaults to the standard hours. */
    hoursWorkedCenti?: number | null;
  } | null;
}

export interface PayslipLine {
  code: string;
  label: string;
  section: "earning" | "deduction" | "employer" | "statutory" | "info";
  sarsCode: string | null;
  amountMinor: number;
  quantityCenti?: number | null;
  rateMinor?: number | null;
}

export interface TraceStep {
  step: number;
  code: string;
  label: string;
  inputs: Record<string, number | string | boolean | null>;
  outputs: Record<string, number | string | boolean | null>;
}

export interface PeriodTotals {
  /** Cash earnings (salary, overtime, bonus, commission, allowances, reimbursements). */
  grossMinor: number;
  /** Taxable fringe benefits (not paid in cash). */
  fringeBenefitsMinor: number;
  /** Regular taxable remuneration for the period before the retirement deduction. */
  regularTaxableMinor: number;
  /** Irregular taxable payments (bonus) in the period. */
  irregularTaxableMinor: number;
  /** Retirement-fund deduction allowed this period. */
  retirementDeductionMinor: number;
  /** Taxable income for the period (regular + irregular − retirement deduction). */
  taxableIncomeMinor: number;
  /** Medical scheme fees tax credit used this period. */
  medicalCreditMinor: number;
  payeMinor: number;
  uifRemunerationMinor: number;
  uifEmployeeMinor: number;
  uifEmployerMinor: number;
  sdlLeviableMinor: number;
  sdlMinor: number;
  etiMinor: number;
  /** Employee deductions other than PAYE and UIF (medical, retirement, loans, garnishees). */
  deductionsMinor: number;
  /** Employer contributions besides UIF and SDL (medical, retirement, group life). */
  employerContributionsMinor: number;
  netPayMinor: number;
  /** Cash earnings + employer contributions + employer UIF + SDL. */
  employerCostMinor: number;
}

export interface PeriodResult {
  employeeId: string;
  taxYear: string;
  periodsPerYear: number;
  ageAtYearEnd: number | null;
  lines: PayslipLine[];
  totals: PeriodTotals;
  /** Amount per SARS source code for this period (IRP5/IT3(a) building blocks). */
  sarsCodes: Record<string, number>;
  /** Ordinary hours for the period (centi-hours) and the hourly rate they give; null when unknown. */
  hours: { ordinaryCenti: number | null; hourlyRateMinor: number | null; belowMinimumWage: boolean };
  trace: TraceStep[];
  warnings: string[];
}

interface Bucket {
  line: PayslipLine;
  kind: ComponentKind;
  taxableMinor: number;
  irregular: boolean;
  uifMinor: number;
  sdlMinor: number;
  cash: boolean;
}

/** Whole years between dateOfBirth and `onDate` (both YYYY-MM-DD). */
export function ageOn(dateOfBirth: string, onDate: string): number {
  const [by, bm, bd] = dateOfBirth.split("-").map(Number) as [number, number, number];
  const [y, m, d] = onDate.split("-").map(Number) as [number, number, number];
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age -= 1;
  return age;
}

/** Calendar months from `start` to `onDate`, counting the start month as month 1. */
export function monthsOfService(start: string, onDate: string): number {
  const [sy, sm] = start.split("-").map(Number) as [number, number];
  const [y, m] = onDate.split("-").map(Number) as [number, number];
  return (y - sy) * 12 + (m - sm) + 1;
}

/** Tax after rebates and the medical credit for an annual taxable amount; never negative. */
export function annualTaxAfterCredits(annualTaxableMinor: number, rules: PayrollRules, age: number | null, annualMedicalCreditMinor: number): {
  beforeRebatesMinor: number;
  rebateMinor: number;
  medicalCreditUsedMinor: number;
  taxMinor: number;
} {
  const beforeRebatesMinor = bracketTax(annualTaxableMinor, rules);
  const rebateMinor = annualRebate(rules, age);
  const afterRebates = Math.max(0, beforeRebatesMinor - rebateMinor);
  const medicalCreditUsedMinor = Math.min(afterRebates, annualMedicalCreditMinor);
  return { beforeRebatesMinor, rebateMinor, medicalCreditUsedMinor, taxMinor: afterRebates - medicalCreditUsedMinor };
}

/** ETI for one month from the band table (cents). */
export function etiFromBands(bands: EtiBand[], monthlyRemunerationMinor: number): number {
  if (monthlyRemunerationMinor <= 0) return 0;
  for (const band of bands) {
    if (band.upToMinor !== null && monthlyRemunerationMinor > band.upToMinor) continue;
    if (band.kind === "none") return 0;
    if (band.kind === "percent") return applyBp(monthlyRemunerationMinor, band.rateBp ?? 0);
    if (band.kind === "fixed") return band.amountMinor ?? 0;
    const reduced = (band.amountMinor ?? 0) - applyBp(monthlyRemunerationMinor - (band.taperFromMinor ?? 0), band.taperBp ?? 0);
    return Math.max(0, reduced);
  }
  return 0;
}

export interface EtiInput {
  rules: PayrollRules;
  eligible: boolean;
  ageAtMonthEnd: number | null;
  /** Qualifying month number (1-based) with this employer, including months claimed before. */
  qualifyingMonth: number;
  monthlyRemunerationMinor: number;
  hoursWorkedCenti: number;
}

/**
 * Employment Tax Incentive for one month. Fewer than the standard monthly
 * hours: the remuneration is grossed up to the standard hours to pick the
 * band, and the result is pro-rated by hours worked.
 */
export function calculateEti(input: EtiInput): { etiMinor: number; reason: string; grossedUpMinor: number; year: 1 | 2 | null } {
  const { rules, eligible } = input;
  const eti = rules.eti;
  if (!eligible) return { etiMinor: 0, reason: "not eligible", grossedUpMinor: 0, year: null };
  if (input.ageAtMonthEnd == null) return { etiMinor: 0, reason: "date of birth missing", grossedUpMinor: 0, year: null };
  if (input.ageAtMonthEnd < eti.minAge || input.ageAtMonthEnd > eti.maxAge) return { etiMinor: 0, reason: `age ${input.ageAtMonthEnd} is outside ${eti.minAge}–${eti.maxAge}`, grossedUpMinor: 0, year: null };
  if (input.qualifyingMonth < 1 || input.qualifyingMonth > eti.maxQualifyingMonths) return { etiMinor: 0, reason: `qualifying month ${input.qualifyingMonth} is past ${eti.maxQualifyingMonths}`, grossedUpMinor: 0, year: null };
  const standardCenti = eti.standardMonthlyHours * 100;
  const hours = input.hoursWorkedCenti > 0 ? input.hoursWorkedCenti : standardCenti;
  if (input.monthlyRemunerationMinor <= 0) return { etiMinor: 0, reason: "no remuneration", grossedUpMinor: 0, year: null };
  const hourlyMinor = divRound(input.monthlyRemunerationMinor * 100, hours);
  if (hourlyMinor < eti.minimumWageHourlyMinor) return { etiMinor: 0, reason: "paid below the minimum wage", grossedUpMinor: 0, year: null };
  const year: 1 | 2 = input.qualifyingMonth <= 12 ? 1 : 2;
  const bands = year === 1 ? eti.firstYear : eti.secondYear;
  if (hours >= standardCenti) {
    return { etiMinor: etiFromBands(bands, input.monthlyRemunerationMinor), reason: `year ${year}`, grossedUpMinor: input.monthlyRemunerationMinor, year };
  }
  const grossedUpMinor = divRound(input.monthlyRemunerationMinor * standardCenti, hours);
  const full = etiFromBands(bands, grossedUpMinor);
  return { etiMinor: divRound(full * hours, standardCenti), reason: `year ${year}, pro-rated for ${hours / 100} hours`, grossedUpMinor, year };
}

function assertInt(value: number | undefined | null, field: string): number {
  const v = value ?? 0;
  if (!Number.isSafeInteger(v) || v < 0) throw new PayrollError(`${field} must be zero or more (whole cents or centi-hours)`);
  return v;
}

/** UIF ceiling for one period: the monthly ceiling × 12 ÷ periods per year. */
export function uifCeilingForPeriod(rules: PayrollRules, frequency: PayFrequency): number {
  const periods = rules.periods[frequency];
  return periods === 12 ? rules.uif.monthlyCeilingMinor : divRound(rules.uif.monthlyCeilingMinor * 12, periods);
}

export function calculatePeriod(input: PeriodInput, rules: PayrollRules, catalogue: ComponentDefinition[] = DEFAULT_COMPONENTS): PeriodResult {
  if (!input.employeeId) throw new PayrollError("employeeId is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(input.periodEnd) || !/^\d{4}-\d{2}-\d{2}$/.test(input.payDate)) {
    throw new PayrollError("Period start, end and pay date must be YYYY-MM-DD");
  }
  if (input.periodEnd < input.periodStart) throw new PayrollError("The period ends before it starts");
  if (input.payDate < rules.startDate || input.payDate > rules.endDate) {
    throw new PayrollError(`Pay date ${input.payDate} is outside tax year ${rules.taxYear}`);
  }
  const periods = rules.periods[input.frequency];
  if (!periods) throw new PayrollError(`Unsupported pay frequency ${input.frequency}`);
  const rate = assertInt(input.rateMinor, "rateMinor");
  const standardHours = assertInt(input.standardHoursCenti, "standardHoursCenti");

  const trace: TraceStep[] = [];
  const warnings: string[] = [];
  const push = (code: string, label: string, inputs: TraceStep["inputs"], outputs: TraceStep["outputs"]) => {
    trace.push({ step: trace.length + 1, code, label, inputs, outputs });
  };
  const buckets: Bucket[] = [];
  const definition = (code: string): ComponentDefinition => {
    const found = componentByCode(catalogue, code) ?? componentByCode(DEFAULT_COMPONENTS, code);
    if (!found) throw new PayrollError(`Unknown pay component ${code}`);
    return found;
  };

  const ageAtYearEnd = input.dateOfBirth ? ageOn(input.dateOfBirth, rules.endDate) : null;
  push("rules", "Use the rule version for the tax year", { taxYear: rules.taxYear, frequency: input.frequency }, { periodsPerYear: periods, ageAtYearEnd });

  /** Adds an amount under a component, applying its treatment. `taxableShareBp` limits the taxable part (travel allowance). */
  const add = (code: string, amountMinor: number, extra: { label?: string | null; quantityCenti?: number; rateMinor?: number; taxableShareBp?: number } = {}) => {
    if (amountMinor === 0) return;
    const c = definition(code);
    const cash = c.kind !== "fringe_benefit" && c.kind !== "employer_contribution";
    const isEarning = c.kind === "earning" || c.kind === "allowance" || c.kind === "travel_allowance" || c.kind === "reimbursement" || c.kind === "fringe_benefit";
    const taxable = isEarning && c.taxable ? (extra.taxableShareBp != null ? applyBp(amountMinor, extra.taxableShareBp) : amountMinor) : 0;
    const section: PayslipLine["section"] =
      c.kind === "deduction_pre_tax" || c.kind === "deduction_post_tax" ? "deduction" : c.kind === "employer_contribution" || c.kind === "fringe_benefit" ? "employer" : "earning";
    buckets.push({
      line: {
        code: c.code,
        label: extra.label?.trim() || c.name,
        section,
        sarsCode: c.sarsCode,
        amountMinor,
        quantityCenti: extra.quantityCenti ?? null,
        rateMinor: extra.rateMinor ?? null,
      },
      kind: c.kind,
      taxableMinor: taxable,
      irregular: c.irregular,
      uifMinor: isEarning && c.uif ? (c.taxable ? taxable : amountMinor) : 0,
      sdlMinor: isEarning && c.sdl ? (c.taxable ? taxable : amountMinor) : 0,
      cash,
    });
  };

  // 1. Ordinary pay
  const unpaidHours = assertInt(input.unpaidLeaveHoursCenti, "unpaidLeaveHoursCenti");
  const hourlyEquivalent = input.workerCategory === "salaried"
    ? (standardHours > 0 ? divRound(rate * 100, standardHours) : 0)
    : rate;
  if (input.workerCategory === "salaried") {
    add(SYSTEM_CODES.basic, rate, { quantityCenti: standardHours || undefined, rateMinor: hourlyEquivalent || undefined });
    let unpaid = 0;
    if (unpaidHours > 0) {
      if (standardHours <= 0) throw new PayrollError("Standard hours are needed to deduct unpaid leave");
      unpaid = divRound(rate * unpaidHours, standardHours);
      if (unpaid > rate) throw new PayrollError("Unpaid leave is more than the salary for the period");
      add(SYSTEM_CODES.unpaidLeave, -unpaid, { quantityCenti: unpaidHours, rateMinor: hourlyEquivalent });
    }
    push("ordinary", "Salary for the period, less unpaid leave", { salaryMinor: rate, standardHoursCenti: standardHours, unpaidLeaveHoursCenti: unpaidHours }, { unpaidLeaveMinor: unpaid, ordinaryMinor: rate - unpaid });
    if (input.paidLeaveHoursCenti) warnings.push("Paid leave for a salaried employee is already in the salary; it is recorded for the leave balance only.");
  } else {
    const ordinaryHours = assertInt(input.ordinaryHoursCenti, "ordinaryHoursCenti");
    const wages = timesHours(rate, ordinaryHours);
    add(SYSTEM_CODES.hourly, wages, { quantityCenti: ordinaryHours, rateMinor: rate });
    const paidLeaveHours = assertInt(input.paidLeaveHoursCenti, "paidLeaveHoursCenti");
    const leavePay = timesHours(rate, paidLeaveHours);
    add(SYSTEM_CODES.paidLeave, leavePay, { quantityCenti: paidLeaveHours, rateMinor: rate });
    if (unpaidHours > 0) warnings.push("Unpaid leave for an hourly employee is simply not paid; it is recorded for the leave balance only.");
    push("ordinary", "Wages for ordinary hours and paid leave", { rateMinor: rate, ordinaryHoursCenti: ordinaryHours, paidLeaveHoursCenti: paidLeaveHours }, { wagesMinor: wages, leavePayMinor: leavePay });
  }

  // 2. Overtime
  const overtimeHours = assertInt(input.overtimeHoursCenti, "overtimeHoursCenti");
  const doubleHours = assertInt(input.doubleTimeHoursCenti, "doubleTimeHoursCenti");
  if (overtimeHours > 0 || doubleHours > 0) {
    if (hourlyEquivalent <= 0) throw new PayrollError("Standard hours are needed to pay overtime on a salary");
    const multiplier = input.overtimeMultiplierBp ?? 15_000;
    const otRate = applyBp(hourlyEquivalent, multiplier);
    const dtRate = applyBp(hourlyEquivalent, 20_000);
    const ot = timesHours(otRate, overtimeHours);
    const dt = timesHours(dtRate, doubleHours);
    add(SYSTEM_CODES.overtime, ot, { quantityCenti: overtimeHours, rateMinor: otRate });
    add(SYSTEM_CODES.doubleTime, dt, { quantityCenti: doubleHours, rateMinor: dtRate });
    push("overtime", "Overtime at the multiplier and double time", { hourlyEquivalentMinor: hourlyEquivalent, multiplierBp: multiplier, overtimeHoursCenti: overtimeHours, doubleTimeHoursCenti: doubleHours }, { overtimeRateMinor: otRate, overtimeMinor: ot, doubleTimeMinor: dt });
  }

  // 3. Travel allowance: fully paid, partly taxable
  if (input.travelAllowance && input.travelAllowance.amountMinor > 0) {
    const amount = assertInt(input.travelAllowance.amountMinor, "travelAllowance.amountMinor");
    const shareBp = input.travelAllowance.businessUseAtLeast80 ? rules.travel.businessUseInclusionBp : rules.travel.inclusionBp;
    add(SYSTEM_CODES.travel, amount, { taxableShareBp: shareBp });
    push("travel", "Travel allowance: the taxable share counts for PAYE", { allowanceMinor: amount, businessUseAtLeast80: input.travelAllowance.businessUseAtLeast80, inclusionBp: shareBp }, { taxablePartMinor: applyBp(amount, shareBp) });
  }

  // 4. Other components
  for (const [i, component] of (input.components ?? []).entries()) {
    const amount = component.amountMinor;
    if (!Number.isSafeInteger(amount) || amount < 0) throw new PayrollError(`Component ${component.code} needs an amount of zero or more cents`);
    const c = definition(component.code);
    if (!c.active) throw new PayrollError(`Pay component ${c.code} is switched off`);
    add(c.code, amount, { label: component.label ?? null });
    push("component", `Add ${c.code}`, { index: i, kind: c.kind, amountMinor: amount, sarsCode: c.sarsCode, taxable: c.taxable, irregular: c.irregular }, { amountMinor: amount });
  }

  // 5. Medical aid
  const medical = input.medical;
  let monthlyCredit = 0;
  if (medical && (medical.employeeContributionMinor > 0 || medical.employerContributionMinor > 0)) {
    add(SYSTEM_CODES.medicalEmployee, assertInt(medical.employeeContributionMinor, "medical.employeeContributionMinor"));
    add(SYSTEM_CODES.medicalEmployer, assertInt(medical.employerContributionMinor, "medical.employerContributionMinor"));
    monthlyCredit = monthlyMedicalCredit(rules, medical.members);
    push("medical", "Medical aid contributions and the monthly tax credit", { members: medical.members, employeeMinor: medical.employeeContributionMinor, employerMinor: medical.employerContributionMinor }, { monthlyCreditMinor: monthlyCredit });
    if (medical.members <= 0) warnings.push("Medical aid contributions without members: no medical tax credit was given.");
  }

  // 6. Retirement fund contributions
  const retirement = input.retirement;
  let retirementAnnual = 0;
  if (retirement && (retirement.employeeContributionMinor > 0 || retirement.employerContributionMinor > 0)) {
    const ee = assertInt(retirement.employeeContributionMinor, "retirement.employeeContributionMinor");
    const er = assertInt(retirement.employerContributionMinor, "retirement.employerContributionMinor");
    const eeCode = retirement.fund === "pension" ? SYSTEM_CODES.pensionEmployee : retirement.fund === "provident" ? SYSTEM_CODES.providentEmployee : SYSTEM_CODES.annuityEmployee;
    const erCode = retirement.fund === "pension" ? SYSTEM_CODES.pensionEmployer : retirement.fund === "provident" ? SYSTEM_CODES.providentEmployer : SYSTEM_CODES.annuityEmployer;
    add(eeCode, ee);
    add(erCode, er);
    retirementAnnual = (ee + er) * periods;
  }

  // 7. Taxable remuneration
  let regularTaxable = 0;
  let irregularTaxable = 0;
  let preTaxOther = 0;
  for (const b of buckets) {
    if (b.taxableMinor !== 0) {
      if (b.irregular) irregularTaxable += b.taxableMinor;
      else regularTaxable += b.taxableMinor;
    }
    if (b.kind === "deduction_pre_tax" && ![SYSTEM_CODES.pensionEmployee, SYSTEM_CODES.providentEmployee, SYSTEM_CODES.annuityEmployee].includes(b.line.code as never)) {
      preTaxOther += b.line.amountMinor;
    }
  }
  regularTaxable = Math.max(0, regularTaxable - preTaxOther);
  const annualRegular = regularTaxable * periods;

  let retirementAllowedAnnual = 0;
  if (retirementAnnual > 0) {
    const pctLimit = applyBp(annualRegular, rules.retirement.deductionRateBp);
    retirementAllowedAnnual = Math.min(retirementAnnual, pctLimit, rules.retirement.annualCapMinor);
    push("retirement", "Retirement-fund deduction, limited to the percentage and the annual cap", {
      contributionsAnnualMinor: retirementAnnual,
      annualRemunerationMinor: annualRegular,
      rateBp: rules.retirement.deductionRateBp,
      annualCapMinor: rules.retirement.annualCapMinor,
    }, { percentageLimitMinor: pctLimit, allowedAnnualMinor: retirementAllowedAnnual });
    if (retirementAllowedAnnual < retirementAnnual) warnings.push("Retirement contributions are above the deductible limit; the excess is not deducted for PAYE.");
  }
  const annualTaxable = Math.max(0, annualRegular - retirementAllowedAnnual);
  push("taxable", "Annual equivalent of regular taxable remuneration", { regularTaxableMinor: regularTaxable, otherPreTaxDeductionsMinor: preTaxOther, periodsPerYear: periods, retirementAllowedAnnualMinor: retirementAllowedAnnual }, { annualTaxableMinor: annualTaxable, irregularTaxableMinor: irregularTaxable });

  // 8. PAYE
  const annualCredit = monthlyCredit * 12;
  const regular = annualTaxAfterCredits(annualTaxable, rules, ageAtYearEnd, annualCredit);
  const regularPaye = divRound(regular.taxMinor, periods);
  push("paye_regular", "PAYE on regular remuneration: brackets, less rebates and the medical credit, spread over the year", {
    annualTaxableMinor: annualTaxable,
    ageAtYearEnd,
    annualMedicalCreditMinor: annualCredit,
  }, { taxBeforeRebatesMinor: regular.beforeRebatesMinor, rebatesMinor: regular.rebateMinor, medicalCreditUsedMinor: regular.medicalCreditUsedMinor, annualTaxMinor: regular.taxMinor, periodPayeMinor: regularPaye });
  let irregularPaye = 0;
  if (irregularTaxable > 0) {
    const withIrregular = annualTaxAfterCredits(annualTaxable + irregularTaxable, rules, ageAtYearEnd, annualCredit);
    irregularPaye = Math.max(0, withIrregular.taxMinor - regular.taxMinor);
    push("paye_irregular", "PAYE on the irregular payment: tax with it minus tax without it", { irregularTaxableMinor: irregularTaxable, annualWithIrregularMinor: annualTaxable + irregularTaxable }, { annualTaxWithMinor: withIrregular.taxMinor, annualTaxWithoutMinor: regular.taxMinor, irregularPayeMinor: irregularPaye });
  }
  const paye = regularPaye + irregularPaye;
  const medicalCreditUsed = divRound(regular.medicalCreditUsedMinor, periods);

  // 9. UIF
  let uifRemuneration = 0;
  for (const b of buckets) uifRemuneration += b.uifMinor;
  uifRemuneration = Math.max(0, uifRemuneration);
  let uifEe = 0;
  let uifEr = 0;
  if (input.uifApplicable) {
    const ceiling = uifCeilingForPeriod(rules, input.frequency);
    const base = Math.min(uifRemuneration, ceiling);
    uifEe = applyBp(base, rules.uif.employeeRateBp);
    uifEr = applyBp(base, rules.uif.employerRateBp);
    push("uif", "UIF on remuneration up to the ceiling", { uifRemunerationMinor: uifRemuneration, ceilingMinor: ceiling, employeeRateBp: rules.uif.employeeRateBp, employerRateBp: rules.uif.employerRateBp }, { baseMinor: base, employeeMinor: uifEe, employerMinor: uifEr });
  } else {
    push("uif", "UIF does not apply to this employee", { uifApplicable: false }, { employeeMinor: 0, employerMinor: 0 });
  }

  // 10. SDL: on the balance of remuneration after the retirement-fund deduction
  let leviable = 0;
  for (const b of buckets) leviable += b.sdlMinor;
  if (rules.sdl.afterRetirementDeduction) leviable -= divRound(retirementAllowedAnnual, periods);
  leviable = Math.max(0, leviable);
  const sdl = input.sdlApplicable ? applyBp(leviable, rules.sdl.rateBp) : 0;
  push("sdl", input.sdlApplicable ? "SDL on the leviable amount (employer only)" : "SDL does not apply this period", { leviableMinor: leviable, rateBp: rules.sdl.rateBp, sdlApplicable: input.sdlApplicable }, { sdlMinor: sdl });

  // Hours and hourly rate (for the minimum-wage check that ETI depends on)
  const ordinaryHoursForPeriod = input.workerCategory === "hourly"
    ? (input.ordinaryHoursCenti ?? 0) + (input.paidLeaveHoursCenti ?? 0)
    : Math.max(0, standardHours - unpaidHours);
  // Wage per ordinary hour, without allowances or benefits (national minimum wage basis).
  const hourlyRate = hourlyEquivalent > 0 ? hourlyEquivalent : null;
  const belowMinimumWage = hourlyRate != null && hourlyRate < rules.eti.minimumWageHourlyMinor;
  if (belowMinimumWage) warnings.push(`Pay works out below the national minimum wage (${hourlyRate} cents an hour).`);

  // 11. ETI (monthly pay only; weekly and fortnightly staff are totalled on the EMP201)
  let eti = 0;
  if (input.eti?.eligible) {
    if (input.frequency !== "monthly") {
      warnings.push("ETI for weekly and fortnightly pay is worked out per month on the EMP201.");
    } else {
      const qualifyingMonth = input.eti.qualifyingMonth;
      const monthlyRemuneration = regularTaxable + irregularTaxable;
      const result = calculateEti({
        rules,
        eligible: true,
        ageAtMonthEnd: input.dateOfBirth ? ageOn(input.dateOfBirth, input.periodEnd) : null,
        qualifyingMonth,
        monthlyRemunerationMinor: monthlyRemuneration,
        hoursWorkedCenti: input.eti.hoursWorkedCenti ?? ordinaryHoursForPeriod,
      });
      eti = result.etiMinor;
      push("eti", "Employment Tax Incentive (reduces the PAYE the employer pays over)", { qualifyingMonth, monthlyRemunerationMinor: monthlyRemuneration, grossedUpMinor: result.grossedUpMinor }, { etiMinor: eti, reason: result.reason });
    }
  }

  // 12. Lines, totals, net pay
  const lines: PayslipLine[] = buckets.map((b) => b.line);
  let gross = 0;
  let fringe = 0;
  let deductions = 0;
  let employerContributions = 0;
  for (const b of buckets) {
    if (b.kind === "deduction_pre_tax" || b.kind === "deduction_post_tax") deductions += b.line.amountMinor;
    else if (b.kind === "fringe_benefit") {
      fringe += b.line.amountMinor;
      employerContributions += b.line.amountMinor;
    } else if (b.kind === "employer_contribution") employerContributions += b.line.amountMinor;
    else gross += b.line.amountMinor;
  }
  lines.push({ code: "PAYE", label: "PAYE (income tax)", section: "statutory", sarsCode: "4102", amountMinor: paye });
  if (uifEe > 0) lines.push({ code: "UIF_EE", label: "UIF (employee)", section: "statutory", sarsCode: "4141", amountMinor: uifEe });
  if (uifEr > 0) lines.push({ code: "UIF_ER", label: "UIF (employer)", section: "employer", sarsCode: "4141", amountMinor: uifEr });
  if (sdl > 0) lines.push({ code: "SDL", label: "Skills development levy", section: "employer", sarsCode: "4142", amountMinor: sdl });
  if (medicalCreditUsed > 0) lines.push({ code: "MEDICAL_CREDIT", label: "Medical tax credit used", section: "info", sarsCode: "4116", amountMinor: medicalCreditUsed });

  const net = gross - paye - uifEe - deductions;
  push("net", "Net pay = cash earnings − PAYE − UIF − deductions", { grossMinor: gross, payeMinor: paye, uifEmployeeMinor: uifEe, deductionsMinor: deductions }, { netPayMinor: net });
  if (net < 0) throw new PayrollError(`Net pay would be negative (${net} cents): reduce the deductions for this period`);

  const retirementDeduction = divRound(retirementAllowedAnnual, periods);
  const totals: PeriodTotals = {
    grossMinor: gross,
    fringeBenefitsMinor: fringe,
    regularTaxableMinor: regularTaxable,
    irregularTaxableMinor: irregularTaxable,
    retirementDeductionMinor: retirementDeduction,
    taxableIncomeMinor: Math.max(0, regularTaxable + irregularTaxable - retirementDeduction),
    medicalCreditMinor: medicalCreditUsed,
    payeMinor: paye,
    uifRemunerationMinor: uifRemuneration,
    uifEmployeeMinor: uifEe,
    uifEmployerMinor: uifEr,
    sdlLeviableMinor: leviable,
    sdlMinor: sdl,
    etiMinor: eti,
    deductionsMinor: deductions,
    employerContributionsMinor: employerContributions,
    netPayMinor: net,
    employerCostMinor: gross + employerContributions + uifEr + sdl,
  };

  return {
    employeeId: input.employeeId,
    taxYear: rules.taxYear,
    periodsPerYear: periods,
    ageAtYearEnd,
    lines,
    totals,
    sarsCodes: sarsCodesFor(buckets, totals),
    hours: { ordinaryCenti: ordinaryHoursForPeriod || null, hourlyRateMinor: hourlyRate, belowMinimumWage },
    trace,
    warnings,
  };
}

/** Amounts per SARS source code for the period. */
function sarsCodesFor(buckets: Bucket[], totals: PeriodTotals): Record<string, number> {
  const codes: Record<string, number> = {};
  const addCode = (code: string | null, amount: number) => {
    if (!code || amount === 0) return;
    codes[code] = (codes[code] ?? 0) + amount;
  };
  // Employer contributions are fringe benefits (38xx), are "deemed paid" by the
  // employee (4001 / 4003 / 4005 / 4006 include them) and, except for
  // retirement annuities, also appear under the employer's own code (44xx).
  const deemed: Record<string, [string, string | null]> = {
    [SYSTEM_CODES.medicalEmployer]: ["4005", "4474"],
    [SYSTEM_CODES.pensionEmployer]: ["4001", "4472"],
    [SYSTEM_CODES.providentEmployer]: ["4003", "4473"],
    [SYSTEM_CODES.annuityEmployer]: ["4006", null],
  };
  for (const b of buckets) {
    addCode(b.line.sarsCode, b.line.amountMinor);
    const extra = deemed[b.line.code];
    if (extra) {
      addCode(extra[0], b.line.amountMinor);
      addCode(extra[1], b.line.amountMinor);
    }
  }
  addCode("4102", totals.payeMinor);
  addCode("4116", totals.medicalCreditMinor);
  addCode("4141", totals.uifEmployeeMinor + totals.uifEmployerMinor);
  addCode("4142", totals.sdlMinor);
  // 4118 (ETI) is on the employer's copy only; the certificate adds it from the monthly figures.
  addCode("4118", totals.etiMinor);
  return codes;
}
