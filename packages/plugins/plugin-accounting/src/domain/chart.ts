/**
 * South African chart of accounts template (IFRS for SMEs style) and the
 * account-role map. Senders post by role (`ar`, `vat_output`,
 * `expense:software`); each company's map turns a role into one of its
 * accounts. The template is a starting point; an accountant should review
 * it before the books are relied on.
 */
import { ACCOUNT_ROLES, type AccountRole } from "@partnersinbiz/pib-plugin-kit";
import { AccountingError } from "./util.js";

export const CHART_TEMPLATE_ID = "za-ifrs-sme-v1";

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_SUBTYPES = [
  "bank",
  "cash",
  "receivable",
  "current_asset",
  "inventory",
  "vat_input",
  "fixed_asset",
  "accumulated_depreciation",
  "suspense",
  "payable",
  "vat_output",
  "vat_control",
  "payroll_liability",
  "current_liability",
  "non_current_liability",
  "equity",
  "retained_earnings",
  "opening_balance_equity",
  "revenue",
  "other_income",
  "cost_of_sales",
  "expense",
  "depreciation",
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

export const CASH_FLOW_CLASSES = ["cash", "operating", "investing", "financing", "none"] as const;
export type CashFlowClass = (typeof CASH_FLOW_CLASSES)[number];

const SUBTYPE_TYPE: Record<AccountSubtype, AccountType> = {
  bank: "asset",
  cash: "asset",
  receivable: "asset",
  current_asset: "asset",
  inventory: "asset",
  vat_input: "asset",
  fixed_asset: "asset",
  accumulated_depreciation: "asset",
  suspense: "asset",
  payable: "liability",
  vat_output: "liability",
  vat_control: "liability",
  payroll_liability: "liability",
  current_liability: "liability",
  non_current_liability: "liability",
  equity: "equity",
  retained_earnings: "equity",
  opening_balance_equity: "equity",
  revenue: "income",
  other_income: "income",
  cost_of_sales: "expense",
  expense: "expense",
  depreciation: "expense",
};

export function typeOfSubtype(subtype: AccountSubtype): AccountType {
  return SUBTYPE_TYPE[subtype];
}

/** Default cash-flow class for a subtype (indirect method). */
export function defaultCashFlow(subtype: AccountSubtype): CashFlowClass {
  if (subtype === "bank" || subtype === "cash") return "cash";
  if (subtype === "fixed_asset") return "investing";
  if (subtype === "non_current_liability" || subtype === "equity") return "financing";
  if (subtype === "retained_earnings" || subtype === "opening_balance_equity") return "none";
  return "operating";
}

export function isSubtype(value: unknown): value is AccountSubtype {
  return typeof value === "string" && (ACCOUNT_SUBTYPES as readonly string[]).includes(value);
}

export interface ChartAccountSeed {
  code: string;
  name: string;
  subtype: AccountSubtype;
  description?: string;
  /** System accounts back a role; they can be renamed but not deactivated. */
  system?: boolean;
}

export const ZA_CHART: ChartAccountSeed[] = [
  // Assets
  { code: "1000", name: "Bank – current account", subtype: "bank", system: true },
  { code: "1010", name: "Petty cash", subtype: "cash", system: true },
  { code: "1100", name: "Accounts receivable (trade debtors)", subtype: "receivable", system: true },
  { code: "1150", name: "Allowance for doubtful debts", subtype: "current_asset" },
  { code: "1200", name: "Prepayments and other receivables", subtype: "current_asset" },
  { code: "1210", name: "Deposits paid", subtype: "current_asset" },
  { code: "1300", name: "Inventory", subtype: "inventory" },
  { code: "1400", name: "VAT input", subtype: "vat_input", system: true, description: "VAT paid on purchases, claimable in the VAT201 (fields 14 and 15)." },
  { code: "1500", name: "Property, plant and equipment (cost)", subtype: "fixed_asset", system: true },
  { code: "1510", name: "Computer equipment (cost)", subtype: "fixed_asset" },
  { code: "1520", name: "Furniture and office equipment (cost)", subtype: "fixed_asset" },
  { code: "1530", name: "Motor vehicles (cost)", subtype: "fixed_asset" },
  { code: "1590", name: "Accumulated depreciation", subtype: "accumulated_depreciation", system: true },
  { code: "1990", name: "Suspense", subtype: "suspense", system: true, description: "Temporary home for amounts that still need a proper account." },
  // Liabilities
  { code: "2000", name: "Accounts payable (trade creditors)", subtype: "payable", system: true },
  { code: "2100", name: "VAT output", subtype: "vat_output", system: true, description: "VAT charged on sales (VAT201 fields 4 and 4A)." },
  { code: "2110", name: "VAT control (SARS)", subtype: "vat_control", system: true, description: "Net VAT owed to or by SARS after each return; payments to SARS post here." },
  { code: "2200", name: "PAYE payable", subtype: "payroll_liability", system: true },
  { code: "2210", name: "UIF payable", subtype: "payroll_liability", system: true },
  { code: "2220", name: "SDL payable", subtype: "payroll_liability", system: true },
  { code: "2230", name: "Net pay clearing (salaries payable)", subtype: "payroll_liability", system: true },
  { code: "2240", name: "Other payroll deductions payable", subtype: "payroll_liability", system: true },
  { code: "2300", name: "Accrued expenses", subtype: "current_liability" },
  { code: "2400", name: "Income received in advance", subtype: "current_liability" },
  { code: "2500", name: "Income tax payable", subtype: "current_liability" },
  { code: "2600", name: "Credit card", subtype: "current_liability" },
  { code: "2700", name: "Loans from directors / shareholders", subtype: "non_current_liability" },
  { code: "2800", name: "Long-term borrowings", subtype: "non_current_liability" },
  // Equity
  { code: "3000", name: "Share capital", subtype: "equity" },
  { code: "3100", name: "Retained earnings", subtype: "retained_earnings", system: true },
  { code: "3200", name: "Opening balance equity", subtype: "opening_balance_equity", system: true, description: "Balancing entry for opening balances at cut-over. Should be cleared to retained earnings by the accountant." },
  { code: "3300", name: "Owner's equity and drawings", subtype: "equity", system: true },
  // Income
  { code: "4000", name: "Sales and services", subtype: "revenue", system: true },
  { code: "4100", name: "Other income", subtype: "other_income" },
  { code: "4200", name: "Interest received", subtype: "other_income" },
  { code: "4300", name: "Other income – Employment Tax Incentive (ETI)", subtype: "other_income", system: true, description: "ETI claimed against PAYE, posted by Payroll (role revenue:employment_tax_incentive)." },
  { code: "4400", name: "Foreign exchange gains", subtype: "other_income", system: true },
  // Cost of sales
  { code: "5000", name: "Cost of sales", subtype: "cost_of_sales", system: true },
  { code: "5100", name: "Subcontractors", subtype: "cost_of_sales" },
  // Expenses
  { code: "6000", name: "Salaries and wages", subtype: "expense", system: true },
  { code: "6010", name: "Employer contributions (UIF, SDL)", subtype: "expense", system: true },
  { code: "6100", name: "Accounting and audit fees", subtype: "expense" },
  { code: "6110", name: "Advertising and marketing", subtype: "expense" },
  { code: "6120", name: "Bank charges", subtype: "expense" },
  { code: "6130", name: "Computer software and subscriptions", subtype: "expense" },
  { code: "6140", name: "Legal and professional fees", subtype: "expense" },
  { code: "6150", name: "Depreciation", subtype: "depreciation", system: true },
  { code: "6160", name: "Entertainment", subtype: "expense" },
  { code: "6170", name: "Insurance", subtype: "expense" },
  { code: "6180", name: "Interest paid", subtype: "expense" },
  { code: "6190", name: "Motor vehicle expenses", subtype: "expense" },
  { code: "6200", name: "Office expenses and stationery", subtype: "expense" },
  { code: "6210", name: "Rent", subtype: "expense" },
  { code: "6220", name: "Repairs and maintenance", subtype: "expense" },
  { code: "6230", name: "Telephone and internet", subtype: "expense" },
  { code: "6240", name: "Training and staff welfare", subtype: "expense" },
  { code: "6250", name: "Travel and accommodation", subtype: "expense" },
  { code: "6260", name: "Electricity and water", subtype: "expense" },
  { code: "6270", name: "Memberships and licences", subtype: "expense" },
  { code: "6280", name: "Courier and postage", subtype: "expense" },
  { code: "6290", name: "Hosting and cloud services", subtype: "expense" },
  { code: "6300", name: "Bad debts", subtype: "expense", system: true },
  { code: "6310", name: "Discount allowed", subtype: "expense", system: true },
  { code: "6400", name: "Foreign exchange losses", subtype: "expense", system: true },
  { code: "6410", name: "Rounding differences", subtype: "expense", system: true },
  { code: "6420", name: "Profit or loss on disposal of assets", subtype: "expense", system: true },
  { code: "6500", name: "General expenses", subtype: "expense", system: true },
  { code: "6900", name: "Income tax expense", subtype: "expense" },
];

/** Every kit role, mapped to a template account. */
export const ZA_ROLE_MAP: Record<AccountRole, string> = {
  bank: "1000",
  cash: "1010",
  ar: "1100",
  ap: "2000",
  revenue: "4000",
  vat_output: "2100",
  vat_input: "1400",
  expense: "6500",
  cost_of_sales: "5000",
  salaries: "6000",
  employer_contributions: "6010",
  paye_payable: "2200",
  uif_payable: "2210",
  sdl_payable: "2220",
  net_pay_clearing: "2230",
  deductions_payable: "2240",
  fx_gain: "4400",
  fx_loss: "6400",
  rounding: "6410",
  discount_allowed: "6310",
  bad_debts: "6300",
  fixed_assets: "1500",
  accumulated_depreciation: "1590",
  depreciation: "6150",
  retained_earnings: "3100",
  opening_balance_equity: "3200",
  owner_equity: "3300",
  suspense: "1990",
};

/** Category roles (`expense:<category>` / `revenue:<category>`) seeded with the chart. */
export const ZA_CATEGORY_ROLES: Record<string, string> = {
  "expense:accounting": "6100",
  "expense:audit": "6100",
  "expense:advertising": "6110",
  "expense:marketing": "6110",
  "expense:bank_charges": "6120",
  "expense:software": "6130",
  "expense:subscriptions": "6130",
  "expense:saas": "6130",
  "expense:legal": "6140",
  "expense:professional_fees": "6140",
  "expense:consulting": "6140",
  "expense:entertainment": "6160",
  "expense:meals": "6160",
  "expense:insurance": "6170",
  "expense:interest": "6180",
  "expense:vehicle": "6190",
  "expense:fuel": "6190",
  "expense:office": "6200",
  "expense:stationery": "6200",
  "expense:rent": "6210",
  "expense:repairs": "6220",
  "expense:telephone": "6230",
  "expense:internet": "6230",
  "expense:training": "6240",
  "expense:travel": "6250",
  "expense:accommodation": "6250",
  "expense:utilities": "6260",
  "expense:memberships": "6270",
  "expense:courier": "6280",
  "expense:hosting": "6290",
  "expense:cloud": "6290",
  "expense:subcontractors": "5100",
  "expense:disposal": "6420",
  "expense:income_tax": "6900",
  "revenue:services": "4000",
  "revenue:sales": "4000",
  "revenue:other": "4100",
  "revenue:interest": "4200",
  "revenue:employment_tax_incentive": "4300",
};

export const ROLE_LABELS: Record<AccountRole, string> = {
  bank: "Bank",
  cash: "Cash",
  ar: "Accounts receivable",
  ap: "Accounts payable",
  revenue: "Revenue",
  vat_output: "VAT output",
  vat_input: "VAT input",
  expense: "Expenses (default)",
  cost_of_sales: "Cost of sales",
  salaries: "Salaries",
  employer_contributions: "Employer contributions",
  paye_payable: "PAYE payable",
  uif_payable: "UIF payable",
  sdl_payable: "SDL payable",
  net_pay_clearing: "Net pay clearing",
  deductions_payable: "Payroll deductions payable",
  fx_gain: "FX gain",
  fx_loss: "FX loss",
  rounding: "Rounding",
  discount_allowed: "Discount allowed",
  bad_debts: "Bad debts",
  fixed_assets: "Fixed assets",
  accumulated_depreciation: "Accumulated depreciation",
  depreciation: "Depreciation",
  retained_earnings: "Retained earnings",
  opening_balance_equity: "Opening balance equity",
  owner_equity: "Owner equity",
  suspense: "Suspense",
};

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  cashFlow: CashFlowClass;
  description: string;
  system: boolean;
  active: boolean;
}

/** Normal balance side: assets and expenses are debit accounts. */
export function isDebitNormal(type: AccountType): boolean {
  return type === "asset" || type === "expense";
}

/** `expense:Software & SaaS` → `expense:software_saas`. Plain roles pass through. */
export function normaliseRole(role: string): string {
  const trimmed = role.trim();
  const i = trimmed.indexOf(":");
  if (i < 0) return trimmed.toLowerCase();
  const head = trimmed.slice(0, i).toLowerCase();
  const tail = trimmed
    .slice(i + 1)
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return tail ? `${head}:${tail}` : head;
}

export function isKnownRoleName(role: string): boolean {
  const r = normaliseRole(role);
  if ((ACCOUNT_ROLES as readonly string[]).includes(r)) return true;
  return /^(expense|revenue):[a-z0-9_]+$/.test(r);
}

/**
 * Account code for a role: the exact role, else the category fallback
 * (`expense:x` → `expense`, `revenue:x` → `revenue`). Null when unmapped.
 */
export function resolveRoleCode(role: string, map: ReadonlyMap<string, string>): string | null {
  const r = normaliseRole(role);
  const direct = map.get(r);
  if (direct) return direct;
  const i = r.indexOf(":");
  if (i > 0) {
    const base = r.slice(0, i);
    if (base === "expense" || base === "revenue") return map.get(base) ?? null;
  }
  return null;
}

/** Validates an account a person is adding or editing. */
export function validateAccountInput(input: { code?: unknown; name?: unknown; subtype?: unknown; cashFlow?: unknown }): {
  code: string;
  name: string;
  subtype: AccountSubtype;
  type: AccountType;
  cashFlow: CashFlowClass;
} {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9.\-]{0,15}$/.test(code)) throw new AccountingError("Account code must be 1–16 letters, digits, dots or dashes");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new AccountingError("Account name is required");
  if (!isSubtype(input.subtype)) throw new AccountingError(`Account kind must be one of: ${ACCOUNT_SUBTYPES.join(", ")}`);
  const subtype = input.subtype;
  const cashFlow = typeof input.cashFlow === "string" && (CASH_FLOW_CLASSES as readonly string[]).includes(input.cashFlow)
    ? (input.cashFlow as CashFlowClass)
    : defaultCashFlow(subtype);
  return { code, name: name.slice(0, 120), subtype, type: typeOfSubtype(subtype), cashFlow };
}

/** Seed rows for the template, ready for a jsonb_to_recordset insert. */
export function chartSeedRows(ids: () => string) {
  return ZA_CHART.map((a) => ({
    id: ids(),
    code: a.code,
    name: a.name,
    type: typeOfSubtype(a.subtype),
    subtype: a.subtype,
    cash_flow: defaultCashFlow(a.subtype),
    description: a.description ?? "",
    system: Boolean(a.system),
  }));
}

export function roleSeedRows(): Array<{ role: string; account_code: string }> {
  return [
    ...Object.entries(ZA_ROLE_MAP).map(([role, account_code]) => ({ role, account_code })),
    ...Object.entries(ZA_CATEGORY_ROLES).map(([role, account_code]) => ({ role, account_code })),
  ];
}
