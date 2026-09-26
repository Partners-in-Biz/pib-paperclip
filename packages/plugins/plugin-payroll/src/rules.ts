/**
 * Payroll rules as data: one version per tax year, stored in the
 * `rule_versions` table (seeded by migration) and read by the engine.
 *
 * Every figure carries a source. A figure that could not be confirmed on the
 * SARS (or Treasury / Labour) site for the tax year is listed in `unverified`
 * and the Payroll page shows a warning until an accountant confirms it.
 */
import { divRound, PayrollError } from "./money.js";

export type PayFrequency = "monthly" | "fortnightly" | "weekly";
export const PAY_FREQUENCIES: PayFrequency[] = ["monthly", "fortnightly", "weekly"];

export interface TaxBracket {
  /** Taxable income above this amount falls in the bracket (annual cents). */
  aboveMinor: number;
  /** Upper bound, inclusive (annual cents); null for the top bracket. */
  upToMinor: number | null;
  /** Tax on income up to `aboveMinor` (annual cents). */
  baseTaxMinor: number;
  /** Marginal rate in basis points (18% = 1800). */
  rateBp: number;
}

/** One ETI band on monthly remuneration. */
export interface EtiBand {
  /** Band applies to monthly remuneration up to and including this (cents); null = no upper limit. */
  upToMinor: number | null;
  kind: "percent" | "fixed" | "taper" | "none";
  /** percent: ETI = remuneration × rateBp. */
  rateBp?: number;
  /** fixed: ETI = amountMinor. taper: ETI = amountMinor − taperBp × (remuneration − taperFromMinor). */
  amountMinor?: number;
  taperBp?: number;
  taperFromMinor?: number;
}

export interface RuleSource {
  /** Dot path(s) of the figures this source covers, e.g. "paye.brackets". */
  covers: string[];
  title: string;
  url: string;
  /** Date the page was checked (YYYY-MM-DD). */
  accessed: string;
  note?: string;
}

export interface PayrollRules {
  taxYear: string; // "2026/27"
  startDate: string; // "2026-03-01"
  endDate: string; // "2027-02-28"
  periods: Record<PayFrequency, number>;
  paye: { brackets: TaxBracket[] };
  rebates: { primaryMinor: number; secondaryMinor: number; tertiaryMinor: number; secondaryAge: number; tertiaryAge: number };
  thresholds: { under65Minor: number; age65to74Minor: number; age75PlusMinor: number };
  /** Monthly medical scheme fees tax credit. */
  medicalCredits: { mainMemberMinor: number; firstDependantMinor: number; additionalDependantMinor: number };
  uif: { employeeRateBp: number; employerRateBp: number; monthlyCeilingMinor: number };
  /** SDL is worked out on remuneration after the retirement-fund deduction (SARS employer guide). */
  sdl: { rateBp: number; annualExemptionThresholdMinor: number; afterRetirementDeduction: boolean };
  eti: {
    minAge: number;
    maxAge: number;
    /** Hours in a month the bands assume; fewer hours are grossed up and the ETI pro-rated. */
    standardMonthlyHours: number;
    /** National minimum wage per hour (cents); ETI needs at least this. */
    minimumWageHourlyMinor: number;
    maxQualifyingMonths: number;
    /** SARS Budget 2026 FAQ: one employee paid below the minimum wage loses the whole month's claim. */
    wholeClaimLostBelowMinimumWage: boolean;
    firstYear: EtiBand[];
    secondYear: EtiBand[];
    effectiveFrom: string;
  };
  retirement: { deductionRateBp: number; annualCapMinor: number };
  travel: { inclusionBp: number; businessUseInclusionBp: number; reimbursiveRatePerKmMinor: number | null };
}

export interface RuleVersion {
  id: string;
  taxYear: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string;
  status: "published" | "draft";
  rules: PayrollRules;
  sources: RuleSource[];
  /** Figures or treatments that could not be confirmed for this tax year (the page shows a warning). */
  unverified: Array<{ path: string; note: string }>;
  /** Discrepancies between official sources and how they were resolved. */
  notes: string[];
  contentHash: string;
}

/** Tax on annual taxable income before rebates (cents). */
export function bracketTax(annualTaxableMinor: number, rules: PayrollRules): number {
  if (annualTaxableMinor <= 0) return 0;
  for (const bracket of rules.paye.brackets) {
    if (bracket.upToMinor === null || annualTaxableMinor <= bracket.upToMinor) {
      return bracket.baseTaxMinor + divRound((annualTaxableMinor - bracket.aboveMinor) * bracket.rateBp, 10_000);
    }
  }
  throw new PayrollError("The tax brackets are incomplete (no top bracket)");
}

export function annualRebate(rules: PayrollRules, ageAtYearEnd: number | null): number {
  let rebate = rules.rebates.primaryMinor;
  if (ageAtYearEnd != null && ageAtYearEnd >= rules.rebates.secondaryAge) rebate += rules.rebates.secondaryMinor;
  if (ageAtYearEnd != null && ageAtYearEnd >= rules.rebates.tertiaryAge) rebate += rules.rebates.tertiaryMinor;
  return rebate;
}

/** Monthly medical scheme fees tax credit for `members` (main member plus dependants). */
export function monthlyMedicalCredit(rules: PayrollRules, members: number): number {
  if (!Number.isInteger(members) || members <= 0) return 0;
  const { mainMemberMinor, firstDependantMinor, additionalDependantMinor } = rules.medicalCredits;
  if (members === 1) return mainMemberMinor;
  return mainMemberMinor + firstDependantMinor + (members - 2) * additionalDependantMinor;
}

/**
 * Internal consistency checks: brackets are contiguous and each base tax is
 * the previous base plus the previous band's tax; thresholds match rebates.
 * Returns problems (empty when consistent).
 */
export function checkRules(rules: PayrollRules): string[] {
  const problems: string[] = [];
  const brackets = rules.paye.brackets;
  if (brackets.length === 0) problems.push("No tax brackets");
  brackets.forEach((b, i) => {
    if (i === 0 && (b.aboveMinor !== 0 || b.baseTaxMinor !== 0)) problems.push("The first bracket must start at 0 with no base tax");
    if (i > 0) {
      const prev = brackets[i - 1]!;
      if (prev.upToMinor !== b.aboveMinor) problems.push(`Bracket ${i + 1} does not start where bracket ${i} ends`);
      const expected = prev.baseTaxMinor + divRound(((prev.upToMinor ?? 0) - prev.aboveMinor) * prev.rateBp, 10_000);
      // Published base amounts are rounded to whole rand.
      if (Math.abs(expected - b.baseTaxMinor) > 100) problems.push(`Bracket ${i + 1} base tax ${b.baseTaxMinor} does not follow from bracket ${i} (${expected})`);
    }
    if (i === brackets.length - 1 && b.upToMinor !== null) problems.push("The top bracket must have no upper limit");
  });
  const firstRate = brackets[0]?.rateBp ?? 0;
  if (firstRate > 0) {
    const thresholds: Array<[string, number, number]> = [
      ["under 65", rules.thresholds.under65Minor, rules.rebates.primaryMinor],
      ["65 to 74", rules.thresholds.age65to74Minor, rules.rebates.primaryMinor + rules.rebates.secondaryMinor],
      ["75 and older", rules.thresholds.age75PlusMinor, rules.rebates.primaryMinor + rules.rebates.secondaryMinor + rules.rebates.tertiaryMinor],
    ];
    for (const [label, threshold, rebate] of thresholds) {
      const tax = bracketTax(threshold, rules);
      if (Math.abs(tax - rebate) > 100) problems.push(`The ${label} threshold (${threshold}) does not match its rebate (${rebate}); tax at the threshold is ${tax}`);
    }
  }
  if (rules.uif.monthlyCeilingMinor <= 0) problems.push("UIF ceiling must be positive");
  for (const f of ["monthly", "fortnightly", "weekly"] as const) {
    if (!Number.isInteger(rules.periods[f]) || rules.periods[f] <= 0) problems.push(`Periods per year for ${f} must be positive`);
  }
  return problems;
}

/** The version whose dates cover `date` (YYYY-MM-DD); the latest version number wins. */
export function ruleVersionFor(versions: RuleVersion[], date: string): RuleVersion | null {
  const matches = versions
    .filter((v) => v.status === "published" && v.effectiveFrom <= date && date <= v.effectiveTo)
    .sort((a, b) => b.version - a.version);
  return matches[0] ?? null;
}

/** "2026/27" for a date in that tax year (1 March to end February). */
export function taxYearOf(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= 3 ? year : year - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

/** First and last day of a tax year label ("2026/27" → 2026-03-01 … 2027-02-28). */
export function taxYearBounds(taxYear: string): { startDate: string; endDate: string } {
  const match = /^(\d{4})\/(\d{2})$/.exec(taxYear);
  if (!match) throw new PayrollError("Tax year must look like 2026/27");
  const start = Number(match[1]);
  const endYear = start + 1;
  const leap = (endYear % 4 === 0 && endYear % 100 !== 0) || endYear % 400 === 0;
  return { startDate: `${start}-03-01`, endDate: `${endYear}-02-${leap ? "29" : "28"}` };
}
