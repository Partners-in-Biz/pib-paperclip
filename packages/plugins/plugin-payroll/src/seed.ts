/**
 * Seed rule version for the 2026/27 tax year (1 March 2026 – 28 February
 * 2027, the 2027 year of assessment). Every figure was checked on
 * sars.gov.za (or Treasury / Labour where SARS has no page) on 2026-09-26.
 * Migration 001 inserts exactly this row (a test keeps them in step).
 */
import { createHash } from "node:crypto";
import type { PayrollRules, RuleSource, RuleVersion } from "./rules.js";

const ACCESSED = "2026-09-26";

export const RULES_2026_27: PayrollRules = {
  taxYear: "2026/27",
  startDate: "2026-03-01",
  endDate: "2027-02-28",
  periods: { monthly: 12, fortnightly: 26, weekly: 52 },
  paye: {
    brackets: [
      { aboveMinor: 0, upToMinor: 24_510_000, baseTaxMinor: 0, rateBp: 1800 },
      { aboveMinor: 24_510_000, upToMinor: 38_310_000, baseTaxMinor: 4_411_800, rateBp: 2600 },
      { aboveMinor: 38_310_000, upToMinor: 53_020_000, baseTaxMinor: 7_999_800, rateBp: 3100 },
      { aboveMinor: 53_020_000, upToMinor: 69_580_000, baseTaxMinor: 12_559_900, rateBp: 3600 },
      { aboveMinor: 69_580_000, upToMinor: 88_700_000, baseTaxMinor: 18_521_500, rateBp: 3900 },
      { aboveMinor: 88_700_000, upToMinor: 187_860_000, baseTaxMinor: 25_978_300, rateBp: 4100 },
      { aboveMinor: 187_860_000, upToMinor: null, baseTaxMinor: 66_633_900, rateBp: 4500 },
    ],
  },
  rebates: { primaryMinor: 1_782_000, secondaryMinor: 976_500, tertiaryMinor: 324_900, secondaryAge: 65, tertiaryAge: 75 },
  thresholds: { under65Minor: 9_900_000, age65to74Minor: 15_325_000, age75PlusMinor: 17_130_000 },
  medicalCredits: { mainMemberMinor: 37_600, firstDependantMinor: 37_600, additionalDependantMinor: 25_400 },
  uif: { employeeRateBp: 100, employerRateBp: 100, monthlyCeilingMinor: 1_771_200 },
  sdl: { rateBp: 100, annualExemptionThresholdMinor: 50_000_000, afterRetirementDeduction: true },
  eti: {
    minAge: 18,
    maxAge: 29,
    standardMonthlyHours: 160,
    minimumWageHourlyMinor: 3_023,
    maxQualifyingMonths: 24,
    wholeClaimLostBelowMinimumWage: true,
    effectiveFrom: "2025-04-01",
    firstYear: [
      { upToMinor: 249_999, kind: "percent", rateBp: 6000 },
      { upToMinor: 549_999, kind: "fixed", amountMinor: 150_000 },
      { upToMinor: 749_999, kind: "taper", amountMinor: 150_000, taperBp: 7500, taperFromMinor: 550_000 },
      { upToMinor: null, kind: "none" },
    ],
    secondYear: [
      { upToMinor: 249_999, kind: "percent", rateBp: 3000 },
      { upToMinor: 549_999, kind: "fixed", amountMinor: 75_000 },
      { upToMinor: 749_999, kind: "taper", amountMinor: 75_000, taperBp: 3750, taperFromMinor: 550_000 },
      { upToMinor: null, kind: "none" },
    ],
  },
  retirement: { deductionRateBp: 2750, annualCapMinor: 43_000_000 },
  travel: { inclusionBp: 8000, businessUseInclusionBp: 2000, reimbursiveRatePerKmMinor: 495 },
};

export const SOURCES_2026_27: RuleSource[] = [
  {
    covers: ["paye.brackets", "rebates", "thresholds"],
    title: "SARS: Rates of tax for individuals (2027 tax year)",
    url: "https://www.sars.gov.za/tax-rates/income-tax/rates-of-tax-for-individuals/",
    accessed: ACCESSED,
    note: "Page last updated 17/03/2026. Same figures in the PAYE-GEN-01-G21 and PAYE-GEN-01-G01 guides.",
  },
  {
    covers: ["paye", "rebates", "thresholds", "medicalCredits", "uif", "sdl", "retirement", "travel"],
    title: "SARS PAYE-GEN-01-G21: Guide for employers in respect of employees' tax for 2027 (Revision 1)",
    url: "https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G21-Guide-for-Employers-iro-Employees-Tax-for-2027-External-Guide.pdf",
    accessed: ACCESSED,
    note: "Deduction tables in effect from 1 March 2026; bonus method; SDL on the balance after allowable deductions.",
  },
  {
    covers: ["paye.brackets", "rebates"],
    title: "SARS PAYE-GEN-01-G01: Guide for employers in respect of tax deduction tables (Revision 16)",
    url: "https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G01-Guide-for-Employers-in-respect-of-Tax-Deduction-Tables-External-Guide.pdf",
    accessed: ACCESSED,
    note: "Age rebates apply if the employee is 65 / 75 on the last day of the year of assessment.",
  },
  {
    covers: ["medicalCredits"],
    title: "SARS: Medical tax credit rates",
    url: "https://www.sars.gov.za/tax-rates/medical-tax-credit-rates/",
    accessed: ACCESSED,
    note: "R376 main member, R376 first dependant, R254 each additional dependant (last updated 25/02/2026).",
  },
  {
    covers: ["uif"],
    title: "SARS: Unemployment Insurance Fund",
    url: "https://www.sars.gov.za/types-of-tax/unemployment-insurance-fund/",
    accessed: ACCESSED,
    note: "1% + 1%, ceiling R17 712 a month since 1 June 2021; no change for 2026/27 (last updated 19/08/2026).",
  },
  {
    covers: ["uif", "treatment.uif"],
    title: "SARS UIF-GEN-01-G01: Guide for employers in respect of the UIF (Revision 9)",
    url: "https://www.sars.gov.za/wp-content/uploads/Ops/Guides/UIF-GEN-01-G01-Guide-for-Employers-in-respect-of-the-Unemployment-Insurance-Fund-External-Guide.pdf",
    accessed: ACCESSED,
    note: "UIF remuneration excludes commission; staff working under 24 hours a month are exempt.",
  },
  {
    covers: ["sdl"],
    title: "SARS: Skills Development Levy",
    url: "https://www.sars.gov.za/types-of-tax/skills-development-levy/",
    accessed: ACCESSED,
    note: "1%; employers expecting leviable remuneration of R500 000 or less over the next 12 months are exempt.",
  },
  {
    covers: ["eti"],
    title: "SARS: Employment Tax Incentive",
    url: "https://www.sars.gov.za/types-of-tax/pay-as-you-earn/employment-tax-incentive-eti/",
    accessed: ACCESSED,
    note: "Bands from 1 April 2025: under R2 500 at 60% / 30%, R2 500–R5 499.99 at R1 500 / R750, tapering to nil at R7 500. Scheme runs to 28 February 2029.",
  },
  {
    covers: ["eti"],
    title: "SARS PAYE-GEN-01-G05: Guide for employers in respect of the ETI (Revision 17)",
    url: "https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G05-Guide-for-Employers-in-respect-of-Employment-Tax-Incentive-External-Guide.pdf",
    accessed: ACCESSED,
    note: "24 qualifying months per employee (counted only when claimed); under 160 hours: gross up, then pro-rate by hours ÷ 160; age 18–29.",
  },
  {
    covers: ["eti.minimumWageHourlyMinor"],
    title: "Department of Employment and Labour: national minimum wage R30.23 per hour",
    url: "https://www.labour.gov.za/minister-of-employment-and-labour-meth-increases-the-statutory-national-minimum-wage-to-r30-23-per-hour",
    accessed: ACCESSED,
    note: "Binding from 1 March 2026 (statement dated 3 February 2026).",
  },
  {
    covers: ["retirement.annualCapMinor", "eti.wholeClaimLostBelowMinimumWage"],
    title: "SARS: Budget 2026 frequently asked questions",
    url: "https://www.sars.gov.za/about/sars-tax-and-customs-system/budget/budget-2026-frequently-asked-questions/",
    accessed: ACCESSED,
    note: "Retirement deduction cap R430 000 from 1 March 2026; one employee paid below the minimum wage disqualifies the month's ETI claim.",
  },
  {
    covers: ["retirement"],
    title: "National Treasury: Budget Review 2026 (Table 4.6)",
    url: "https://www.treasury.gov.za/documents/National%20Budget/2026/review/FullBR.pdf",
    accessed: ACCESSED,
    note: "Retirement cap raised from R350 000 (set in 2016) to R430 000, effective 1 March 2026.",
  },
  {
    covers: ["travel"],
    title: "SARS: Rates per kilometer",
    url: "https://www.sars.gov.za/tax-rates/employers/rates-per-kilometer/",
    accessed: ACCESSED,
    note: "Prescribed rate R4.95 per km from 1 March 2026 (last updated 26/02/2026).",
  },
  {
    covers: ["travel"],
    title: "SARS PAYE-GEN-01-G03: Guide for employers in respect of allowances (2027 tax year)",
    url: "https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G03-Guide-for-Employers-in-respect-of-Allowances-External-Guide.pdf",
    accessed: ACCESSED,
    note: "80% of a travel allowance is included for PAYE, or 20% if at least 80% of use is for business; the full allowance goes under 3701.",
  },
  {
    covers: ["statutory.sourceCodes"],
    title: "SARS PAYE-AE-06-G06: Guide for codes applicable to employees tax certificates 2027 (Revision 14)",
    url: "https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-AE-06-G06-Guide-for-Codes-Applicable-to-Employees-Tax-Certificates-2027-External-Guide.pdf",
    accessed: ACCESSED,
    note: "Codes 3601–3828, 4001–4006, 4102, 4115, 4116, 4118, 4141, 4142, 4149, 4150, 4472–4474, 4497. 3615, 3697, 3698, 4101 and 4103 are discontinued.",
  },
  {
    covers: ["statutory.emp201"],
    title: "SARS: Completing the monthly employer declaration (EMP201)",
    url: "https://www.sars.gov.za/types-of-tax/pay-as-you-earn/completing-the-monthly-employer-declaration-emp201/",
    accessed: ACCESSED,
    note: "PAYE payable is PAYE less ETI utilised; due by the 7th (or the last business day before).",
  },
  {
    covers: ["leave"],
    title: "Basic Conditions of Employment Act 75 of 1997 (sections 20, 22 and 27)",
    url: "https://www.labour.gov.za/DocumentCenter/Acts/Basic%20Conditions%20of%20Employment/Act%20-%20Basic%20Conditions%20of%20Employment.pdf",
    accessed: ACCESSED,
    note: "21 consecutive days annual leave; 6 weeks' working days sick leave per 36 months (1 per 26 days in the first 6 months); 3 days family responsibility after 4 months for 4+ days a week.",
  },
];

export const UNVERIFIED_2026_27: RuleVersion["unverified"] = [
  {
    path: "treatment.uifFringeBenefits",
    note: "UIF is charged on taxable fringe benefits (employer medical and retirement contributions). SARS lists what UIF excludes and these are not on the list, but no SARS page says so directly.",
  },
  {
    path: "treatment.uifSdlTravelAllowance",
    note: "UIF and SDL are charged on the taxable part (80% or 20%) of a travel allowance. Inferred from the Fourth Schedule; not stated by SARS.",
  },
  {
    path: "statutory.it3aReasonCode",
    note: "IT3(a) certificates default to reason code 02. SARS accepts codes 02 to 10; check the right one per employee in the certificate guide.",
  },
  {
    path: "leave.annualWorkingDays",
    note: "Annual leave is shown as days per week × 3 working days (15 for a 5-day week). The Act says 21 consecutive days; the working-day figure is derived.",
  },
];

export const NOTES_2026_27: string[] = [
  "Retirement cap: SARS and Treasury apply R430 000 from 1 March 2026; one industry report says the Rates Act gazetted on 1 April 2026 left it out. Follow SARS unless told otherwise.",
  "ETI and the minimum wage: the SARS ETI guide disqualifies only the employee paid below the minimum wage; the Budget 2026 FAQ says the whole month's claim is lost. The stricter FAQ rule is used.",
  "The SARS tables guide heading says 2025/2026 but its dates and rates are for 2026/27 (1 March 2026 to 28 February 2027).",
  "SARS's own bonus example in the 2027 employer guide does not reconcile with the 2027 table; the method (tax with minus tax without) is used.",
];

/** Stable JSON (sorted keys) so the hash does not depend on key order. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function rulesHash(rules: PayrollRules): string {
  return createHash("sha256").update(stableJson(rules)).digest("hex");
}

export const RULE_VERSION_2026_27: RuleVersion = {
  id: "za-2026-27-v1",
  taxYear: "2026/27",
  version: 1,
  effectiveFrom: "2026-03-01",
  effectiveTo: "2027-02-28",
  status: "published",
  rules: RULES_2026_27,
  sources: SOURCES_2026_27,
  unverified: UNVERIFIED_2026_27,
  notes: NOTES_2026_27,
  contentHash: rulesHash(RULES_2026_27),
};

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The INSERT for a seeded rule version (used by migration 001 and its test). */
export function ruleSeedSql(ns: string, version: RuleVersion): string {
  return `INSERT INTO ${ns}.rule_versions (id, tax_year, version, effective_from, effective_to, status, rules, sources, unverified, notes, content_hash)
VALUES (${sqlText(version.id)}, ${sqlText(version.taxYear)}, ${version.version}, ${sqlText(version.effectiveFrom)}, ${sqlText(version.effectiveTo)}, ${sqlText(version.status)},
  ${sqlText(stableJson(version.rules))}::jsonb,
  ${sqlText(JSON.stringify(version.sources))}::jsonb,
  ${sqlText(JSON.stringify(version.unverified))}::jsonb,
  ${sqlText(JSON.stringify(version.notes))}::jsonb,
  ${sqlText(version.contentHash)})
ON CONFLICT (id) DO NOTHING;`;
}
