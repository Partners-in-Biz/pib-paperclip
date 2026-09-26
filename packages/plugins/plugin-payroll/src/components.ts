/**
 * Pay components: the earnings, allowances, deductions, employer
 * contributions and fringe benefits a pay run can contain, with their SARS
 * IRP5/IT3(a) source codes and tax, UIF and SDL treatment.
 *
 * The defaults below are built in. A company can add its own components
 * (table `components`) or override a default's code or treatment.
 * Treatments follow the SARS employer guides; an accountant should confirm
 * them before relying on them (see the rule version's sources).
 */
import { PayrollError } from "./money.js";

export type ComponentKind =
  | "earning"
  | "allowance"
  | "travel_allowance"
  | "reimbursement"
  | "fringe_benefit"
  | "deduction_pre_tax"
  | "deduction_post_tax"
  | "employer_contribution";

export const COMPONENT_KINDS: ComponentKind[] = [
  "earning",
  "allowance",
  "travel_allowance",
  "reimbursement",
  "fringe_benefit",
  "deduction_pre_tax",
  "deduction_post_tax",
  "employer_contribution",
];

export interface ComponentDefinition {
  code: string;
  name: string;
  kind: ComponentKind;
  /** SARS IRP5/IT3(a) source code the amount is reported under, or null (not reported). */
  sarsCode: string | null;
  /** Counts as taxable remuneration (earnings, taxable allowances, fringe benefits). */
  taxable: boolean;
  /** Irregular payment (bonus, annual payment): taxed without annualising. */
  irregular: boolean;
  /** Included in UIF remuneration. */
  uif: boolean;
  /** Included in the SDL leviable amount. */
  sdl: boolean;
  builtIn: boolean;
  active: boolean;
}

function def(code: string, name: string, kind: ComponentKind, sarsCode: string | null, flags: Partial<Pick<ComponentDefinition, "taxable" | "irregular" | "uif" | "sdl">> = {}): ComponentDefinition {
  const taxableDefault = kind === "earning" || kind === "allowance" || kind === "travel_allowance" || kind === "fringe_benefit";
  const taxable = flags.taxable ?? taxableDefault;
  return {
    code,
    name,
    kind,
    sarsCode,
    taxable,
    irregular: flags.irregular ?? false,
    uif: flags.uif ?? taxable,
    sdl: flags.sdl ?? taxable,
    builtIn: true,
    active: true,
  };
}

/** Codes the engine generates itself from the employment terms. */
export const SYSTEM_CODES = {
  basic: "BASIC",
  hourly: "HOURLY",
  overtime: "OVERTIME",
  doubleTime: "DOUBLE_TIME",
  paidLeave: "LEAVE_PAID",
  unpaidLeave: "LEAVE_UNPAID",
  travel: "TRAVEL_ALLOWANCE",
  medicalEmployee: "MEDICAL_EE",
  medicalEmployer: "MEDICAL_ER",
  pensionEmployee: "PENSION_EE",
  providentEmployee: "PROVIDENT_EE",
  annuityEmployee: "RA_EE",
  pensionEmployer: "PENSION_ER",
  providentEmployer: "PROVIDENT_ER",
  annuityEmployer: "RA_ER",
} as const;

export const DEFAULT_COMPONENTS: ComponentDefinition[] = [
  def("BASIC", "Basic salary", "earning", "3601"),
  def("HOURLY", "Wages (ordinary hours)", "earning", "3601"),
  def("OVERTIME", "Overtime", "earning", "3607"),
  def("DOUBLE_TIME", "Sunday and public holiday time", "earning", "3607"),
  def("LEAVE_PAID", "Paid leave", "earning", "3601"),
  def("LEAVE_UNPAID", "Unpaid leave", "earning", "3601"),
  def("BONUS", "Bonus", "earning", "3605", { irregular: true }),
  def("ANNUAL_PAYMENT", "Annual payment (13th cheque)", "earning", "3605", { irregular: true }),
  // Commission is excluded from UIF remuneration (SARS UIF guide).
  def("COMMISSION", "Commission", "earning", "3606", { uif: false }),
  def("BACK_PAY", "Back pay", "earning", "3601"),
  def("TRAVEL_ALLOWANCE", "Travel allowance", "travel_allowance", "3701"),
  def("REIMB_TRAVEL", "Reimbursive travel (at or below the SARS rate)", "reimbursement", "3703", { taxable: false }),
  def("CELLPHONE_ALLOWANCE", "Cellphone allowance", "allowance", "3713"),
  def("OTHER_ALLOWANCE", "Other allowance (taxable)", "allowance", "3713"),
  def("NONTAX_ALLOWANCE", "Other allowance (non-taxable)", "allowance", "3714", { taxable: false }),
  def("REIMBURSEMENT", "Expense reimbursement", "reimbursement", null, { taxable: false }),
  def("FRINGE_GENERAL", "Taxable benefit (general)", "fringe_benefit", "3801"),
  def("MEDICAL_ER", "Medical aid (employer contribution)", "fringe_benefit", "3810"),
  def("PENSION_ER", "Pension fund (employer contribution)", "fringe_benefit", "3817"),
  def("PROVIDENT_ER", "Provident fund (employer contribution)", "fringe_benefit", "3825"),
  def("RA_ER", "Retirement annuity (employer contribution)", "fringe_benefit", "3828"),
  def("MEDICAL_EE", "Medical aid (employee contribution)", "deduction_post_tax", "4005"),
  def("PENSION_EE", "Pension fund (employee contribution)", "deduction_pre_tax", "4001"),
  def("PROVIDENT_EE", "Provident fund (employee contribution)", "deduction_pre_tax", "4003"),
  def("RA_EE", "Retirement annuity (employee contribution)", "deduction_pre_tax", "4006"),
  def("GARNISHEE", "Garnishee order", "deduction_post_tax", null),
  def("STAFF_LOAN", "Staff loan repayment", "deduction_post_tax", null),
  def("UNION_FEES", "Union fees", "deduction_post_tax", null),
  def("OTHER_DEDUCTION", "Other deduction", "deduction_post_tax", null),
  def("GROUP_LIFE_ER", "Group life (employer, non-taxable)", "employer_contribution", null, { taxable: false }),
];

export const SARS_CODE_LABELS: Record<string, string> = {
  "3601": "Income (salary, wages, leave pay)",
  "3605": "Annual payment (bonus)",
  "3606": "Commission",
  "3607": "Overtime",
  "3696": "Gross non-taxable income",
  "3699": "Gross employment income (taxable)",
  "3701": "Travel allowance",
  "3702": "Reimbursive travel allowance (taxable)",
  "3703": "Reimbursive travel allowance (non-taxable)",
  "3713": "Other allowances (taxable)",
  "3714": "Other allowances (non-taxable)",
  "3801": "General fringe benefits",
  "3810": "Medical scheme fees fringe benefit",
  "3817": "Employer contributions to pension funds",
  "3825": "Employer contributions to provident funds",
  "3828": "Employer contributions to retirement annuity funds",
  "4001": "Pension fund contributions (paid and deemed paid)",
  "4003": "Provident fund contributions (paid and deemed paid)",
  "4005": "Medical scheme fees (paid and deemed paid)",
  "4006": "Retirement annuity fund contributions (paid and deemed paid)",
  "4102": "PAYE",
  "4115": "Tax on retirement lump sums",
  "4116": "Medical scheme fees tax credit",
  "4118": "Employment Tax Incentive (employer copy only)",
  "4141": "UIF contributions (employee and employer)",
  "4142": "SDL contributions",
  "4149": "Total tax, SDL and UIF",
  "4472": "Employer pension fund contributions",
  "4473": "Employer provident fund contributions",
  "4474": "Employer medical scheme contributions",
  "4497": "Total deductions and contributions",
};

const CODE_RE = /^[A-Z][A-Z0-9_]{1,31}$/;

export function normaliseCode(value: unknown): string {
  const code = String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_");
  if (!CODE_RE.test(code)) throw new PayrollError("A component code is 2 to 32 letters, digits or underscores and starts with a letter");
  return code;
}

export function assertKind(value: unknown): ComponentKind {
  if (typeof value === "string" && (COMPONENT_KINDS as string[]).includes(value)) return value as ComponentKind;
  throw new PayrollError(`Component kind must be one of: ${COMPONENT_KINDS.join(", ")}`);
}

export function assertSarsCode(value: unknown): string | null {
  if (value == null || value === "") return null;
  const code = String(value).trim();
  if (!/^\d{4}$/.test(code)) throw new PayrollError("A SARS source code is four digits, e.g. 3601");
  return code;
}

/** Built-in defaults overlaid with the company's own rows (same code replaces the default). */
export function mergeComponents(custom: ComponentDefinition[]): ComponentDefinition[] {
  const byCode = new Map<string, ComponentDefinition>(DEFAULT_COMPONENTS.map((c) => [c.code, c]));
  for (const row of custom) byCode.set(row.code, { ...row, builtIn: DEFAULT_COMPONENTS.some((d) => d.code === row.code) });
  return [...byCode.values()].sort((a, b) => COMPONENT_KINDS.indexOf(a.kind) - COMPONENT_KINDS.indexOf(b.kind) || a.code.localeCompare(b.code));
}

export function componentByCode(list: ComponentDefinition[], code: string): ComponentDefinition | null {
  return list.find((c) => c.code === code) ?? null;
}
