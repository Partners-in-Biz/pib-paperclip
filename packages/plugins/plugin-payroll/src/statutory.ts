/**
 * Statutory evidence and exports (no SARS submission): the monthly EMP201
 * summary, IRP5 / IT3(a) certificates per employee per tax year, and the
 * EMP501 reconciliation pack. Built from locked pay runs (reversals count
 * negative) plus YTD openings imported at cut-over.
 */
import { calculateEti, ageOn } from "./engine.js";
import { minorToDecimal, PayrollError } from "./money.js";
import { taxYearBounds, type PayrollRules } from "./rules.js";

export interface StatutoryItem {
  runId: string;
  runNumber: string;
  runKind: "regular" | "correction" | "reversal";
  employeeId: string;
  payDate: string;
  frequency: "monthly" | "fortnightly" | "weekly";
  totals: {
    grossMinor: number;
    payeMinor: number;
    uifEmployeeMinor: number;
    uifEmployerMinor: number;
    sdlMinor: number;
    etiMinor: number;
    regularTaxableMinor: number;
    irregularTaxableMinor: number;
    netPayMinor: number;
  };
  sarsCodes: Record<string, number>;
  /** Hours worked (for ETI on weekly/fortnightly pay), centi-hours. */
  hoursCenti?: number | null;
  /** The pay worked out below the national minimum wage. */
  belowMinimumWage?: boolean;
}

export interface EtiEmployee {
  employeeId: string;
  eligible: boolean;
  dateOfBirth: string | null;
  /** This month's number among the employee's ETI months (1 = first). */
  qualifyingMonth: number;
}

export interface Emp201 {
  month: string; // YYYY-MM
  taxYear: string;
  employees: number;
  payeMinor: number;
  sdlMinor: number;
  uifMinor: number;
  etiCalculatedMinor: number;
  etiBroughtForwardMinor: number;
  etiUsedMinor: number;
  etiCarriedForwardMinor: number;
  payeAfterEtiMinor: number;
  totalPayableMinor: number;
  dueDate: string;
  runs: string[];
  notes: string[];
}

/** Easter Sunday (Gregorian, anonymous algorithm). */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

/** South African public holidays for a year (a Sunday holiday moves to Monday). */
export function saPublicHolidays(year: number): Set<string> {
  const fixed = ["01-01", "03-21", "04-27", "05-01", "06-16", "08-09", "09-24", "12-16", "12-25", "12-26"];
  const days = new Set<string>();
  for (const md of fixed) {
    const d = new Date(`${year}-${md}T00:00:00Z`);
    days.add(d.toISOString().slice(0, 10));
    if (d.getUTCDay() === 0) days.add(new Date(d.getTime() + 86_400_000).toISOString().slice(0, 10));
  }
  const easter = easterSunday(year);
  days.add(new Date(easter.getTime() - 2 * 86_400_000).toISOString().slice(0, 10)); // Good Friday
  days.add(new Date(easter.getTime() + 86_400_000).toISOString().slice(0, 10)); // Family Day
  return days;
}

/** 7th of the next month; a weekend or public holiday moves it to the last business day before. */
export function emp201DueDate(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const due = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 7));
  const holidays = saPublicHolidays(due.getUTCFullYear());
  while (due.getUTCDay() === 0 || due.getUTCDay() === 6 || holidays.has(due.toISOString().slice(0, 10))) due.setUTCDate(due.getUTCDate() - 1);
  return due.toISOString().slice(0, 10);
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * EMP201 for one month. ETI on monthly pay comes from the pay runs; for
 * weekly and fortnightly staff it is worked out here on the month's total.
 */
export function buildEmp201(input: {
  month: string;
  items: StatutoryItem[];
  rules: PayrollRules;
  etiEmployees?: EtiEmployee[];
  etiBroughtForwardMinor?: number;
}): Emp201 {
  if (!/^\d{4}-\d{2}$/.test(input.month)) throw new PayrollError("Month must be YYYY-MM");
  const items = input.items.filter((i) => monthOf(i.payDate) === input.month);
  const notes: string[] = [];
  let paye = 0;
  let sdl = 0;
  let uif = 0;
  let eti = 0;
  const employees = new Set<string>();
  const nonMonthly = new Map<string, { remuneration: number; hours: number; frequency: string }>();
  for (const item of items) {
    employees.add(item.employeeId);
    paye += item.totals.payeMinor;
    sdl += item.totals.sdlMinor;
    uif += item.totals.uifEmployeeMinor + item.totals.uifEmployerMinor;
    if (item.frequency === "monthly") eti += item.totals.etiMinor;
    else {
      const agg = nonMonthly.get(item.employeeId) ?? { remuneration: 0, hours: 0, frequency: item.frequency };
      agg.remuneration += item.totals.regularTaxableMinor + item.totals.irregularTaxableMinor;
      agg.hours += item.hoursCenti ?? 0;
      nonMonthly.set(item.employeeId, agg);
    }
  }
  const monthEnd = lastDayOfMonth(input.month);
  let nonMonthlyEti = 0;
  for (const [employeeId, agg] of nonMonthly) {
    const who = input.etiEmployees?.find((e) => e.employeeId === employeeId);
    if (!who?.eligible) continue;
    const result = calculateEti({
      rules: input.rules,
      eligible: true,
      ageAtMonthEnd: who.dateOfBirth ? ageOn(who.dateOfBirth, monthEnd) : null,
      qualifyingMonth: who.qualifyingMonth,
      monthlyRemunerationMinor: agg.remuneration,
      hoursWorkedCenti: agg.hours,
    });
    nonMonthlyEti += result.etiMinor;
  }
  eti += nonMonthlyEti;
  if (nonMonthlyEti) notes.push("ETI for weekly and fortnightly staff was worked out on the month's total.");
  const below = items.filter((i) => i.belowMinimumWage).map((i) => i.employeeId);
  if (below.length && input.rules.eti.wholeClaimLostBelowMinimumWage && eti > 0) {
    notes.push(`No ETI is claimed: ${new Set(below).size} employee(s) were paid below the national minimum wage, which SARS says disqualifies the whole month's claim.`);
    eti = 0;
  }
  const broughtForward = input.etiBroughtForwardMinor ?? 0;
  const available = Math.max(0, eti) + broughtForward;
  const used = Math.max(0, Math.min(available, paye));
  const taxYear = taxYearLabel(input.month);
  return {
    month: input.month,
    taxYear,
    employees: employees.size,
    payeMinor: paye,
    sdlMinor: sdl,
    uifMinor: uif,
    etiCalculatedMinor: eti,
    etiBroughtForwardMinor: broughtForward,
    etiUsedMinor: used,
    etiCarriedForwardMinor: available - used,
    payeAfterEtiMinor: paye - used,
    totalPayableMinor: paye - used + sdl + uif,
    dueDate: emp201DueDate(input.month),
    runs: [...new Set(items.map((i) => i.runNumber))],
    notes,
  };
}

function lastDayOfMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function taxYearLabel(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = m >= 3 ? y : y - 1;
  return `${start}/${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Months (YYYY-MM) of a tax year, March to February; `interim` stops at August. */
export function taxYearMonths(taxYear: string, period: "annual" | "interim" = "annual"): string[] {
  const { startDate } = taxYearBounds(taxYear);
  const start = Number(startDate.slice(0, 4));
  const months: string[] = [];
  for (let i = 0; i < (period === "interim" ? 6 : 12); i += 1) {
    const m = ((2 + i) % 12) + 1;
    const y = start + (2 + i >= 12 ? 1 : 0);
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return months;
}

// ---------------------------------------------------------------------------
// IRP5 / IT3(a)
// ---------------------------------------------------------------------------

/** Income codes that are not taxable (summed into 3696). */
export const NON_TAXABLE_INCOME_CODES = new Set(["3703", "3714", "3922"]);
/** 4497 is the total of all 40xx deduction, 44xx contribution and 45xx information codes. */
export function isDeductionCode(code: string): boolean {
  const n = Number(code);
  return code !== "4497" && ((n >= 4001 && n <= 4099) || (n >= 4400 && n <= 4599));
}

export interface Ytd {
  employeeId: string;
  taxYear: string;
  codes: Record<string, number>;
  payeMinor: number;
  uifMinor: number;
  sdlMinor: number;
  etiMinor: number;
  grossMinor: number;
}

export interface CertificateEmployee {
  employeeId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string | null;
  startDate: string;
  endDate: string | null;
  /** Opened only for export; masked on screen. */
  idNumber?: string | null;
  passportNumber?: string | null;
  passportCountry?: string | null;
  taxReference?: string | null;
}

export interface Certificate {
  employeeId: string;
  employeeNumber: string;
  name: string;
  taxYear: string;
  kind: "IRP5" | "IT3(a)";
  /** IT3(a) reason code (4150) when no PAYE was deducted. */
  reasonCode: string | null;
  periodStart: string;
  periodEnd: string;
  payPeriods: number;
  codes: Record<string, number>;
  /** Derived totals. */
  grossTaxableMinor: number; // 3699
  grossNonTaxableMinor: number; // 3696
  totalDeductionsMinor: number; // 4497
  totalTaxMinor: number; // 4149
  payeMinor: number;
  uifMinor: number;
  sdlMinor: number;
  includesOpening: boolean;
}

/** Sums codes; derived totals follow the SARS certificate layout. */
export function buildCertificate(input: {
  employee: CertificateEmployee;
  taxYear: string;
  items: StatutoryItem[];
  ytd?: Ytd | null;
  it3aReasonCode?: string;
}): Certificate {
  const { startDate, endDate } = taxYearBounds(input.taxYear);
  const items = input.items.filter((i) => i.employeeId === input.employee.employeeId && i.payDate >= startDate && i.payDate <= endDate);
  const codes: Record<string, number> = {};
  const add = (code: string, amount: number) => {
    if (!amount) return;
    codes[code] = (codes[code] ?? 0) + amount;
  };
  for (const item of items) for (const [code, amount] of Object.entries(item.sarsCodes)) add(code, amount);
  const ytd = input.ytd && input.ytd.taxYear === input.taxYear ? input.ytd : null;
  if (ytd) for (const [code, amount] of Object.entries(ytd.codes)) add(code, amount);
  // SARS certificates show rand amounts; keep cents here and round on export.
  let grossTaxable = 0;
  let grossNonTaxable = 0;
  let deductions = 0;
  for (const [code, amount] of Object.entries(codes)) {
    const n = Number(code);
    if (n >= 3601 && n <= 3907 && !["3696", "3697", "3698", "3699"].includes(code)) {
      if (NON_TAXABLE_INCOME_CODES.has(code)) grossNonTaxable += amount;
      else grossTaxable += amount;
    }
    if (isDeductionCode(code)) deductions += amount;
  }
  const paye = codes["4102"] ?? 0;
  const uif = codes["4141"] ?? 0;
  const sdl = codes["4142"] ?? 0;
  const lumpSumTax = codes["4115"] ?? 0;
  if (grossTaxable) codes["3699"] = grossTaxable;
  if (grossNonTaxable) codes["3696"] = grossNonTaxable;
  if (deductions) codes["4497"] = deductions;
  const totalTax = paye + lumpSumTax + uif + sdl;
  if (totalTax) codes["4149"] = totalTax;
  // 4118 (ETI) may not exceed 75% of 3699 from the 2027 year of assessment.
  if (codes["4118"] && codes["4118"] > Math.floor((grossTaxable * 3) / 4)) codes["4118"] = Math.floor((grossTaxable * 3) / 4);
  if (codes["4118"] != null && codes["4118"] <= 0) delete codes["4118"];
  const periodStart = input.employee.startDate > startDate ? input.employee.startDate : startDate;
  const periodEnd = input.employee.endDate && input.employee.endDate < endDate ? input.employee.endDate : endDate;
  const kind = paye > 0 ? "IRP5" : "IT3(a)";
  return {
    employeeId: input.employee.employeeId,
    employeeNumber: input.employee.employeeNumber,
    name: `${input.employee.firstName} ${input.employee.lastName}`.trim(),
    taxYear: input.taxYear,
    kind,
    reasonCode: kind === "IT3(a)" ? input.it3aReasonCode ?? "02" : null,
    periodStart,
    periodEnd,
    payPeriods: new Set(items.filter((i) => i.runKind !== "reversal").map((i) => `${i.runId}`)).size,
    codes,
    grossTaxableMinor: grossTaxable,
    grossNonTaxableMinor: grossNonTaxable,
    totalDeductionsMinor: deductions,
    totalTaxMinor: totalTax,
    payeMinor: paye,
    uifMinor: uif,
    sdlMinor: sdl,
    includesOpening: Boolean(ytd),
  };
}

// ---------------------------------------------------------------------------
// EMP501
// ---------------------------------------------------------------------------

export interface Emp501 {
  taxYear: string;
  period: "annual" | "interim";
  months: Emp201[];
  declared: { payeMinor: number; sdlMinor: number; uifMinor: number; etiMinor: number; totalMinor: number };
  /** Declared from the old payroll before cut-over (included in `declared`). */
  beforeCutOver: { payeMinor: number; sdlMinor: number; uifMinor: number; etiMinor: number };
  certificates: { count: number; irp5: number; it3a: number; payeMinor: number; sdlMinor: number; uifMinor: number };
  difference: { payeMinor: number; sdlMinor: number; uifMinor: number };
  reconciled: boolean;
}

/**
 * EMP201 totals for the months versus the certificates' totals. `beforeCutOver`
 * is what was declared from the old payroll (the YTD openings), so a
 * mid-year switch still reconciles.
 */
export function buildEmp501(
  taxYear: string,
  period: "annual" | "interim",
  months: Emp201[],
  certificates: Certificate[],
  beforeCutOver: { payeMinor: number; sdlMinor: number; uifMinor: number; etiMinor: number } = { payeMinor: 0, sdlMinor: 0, uifMinor: 0, etiMinor: 0 },
): Emp501 {
  const declared = months.reduce(
    (acc, m) => ({
      payeMinor: acc.payeMinor + m.payeMinor,
      sdlMinor: acc.sdlMinor + m.sdlMinor,
      uifMinor: acc.uifMinor + m.uifMinor,
      etiMinor: acc.etiMinor + m.etiUsedMinor,
      totalMinor: acc.totalMinor + m.totalPayableMinor,
    }),
    {
      payeMinor: beforeCutOver.payeMinor,
      sdlMinor: beforeCutOver.sdlMinor,
      uifMinor: beforeCutOver.uifMinor,
      etiMinor: beforeCutOver.etiMinor,
      totalMinor: beforeCutOver.payeMinor - beforeCutOver.etiMinor + beforeCutOver.sdlMinor + beforeCutOver.uifMinor,
    },
  );
  const certs = certificates.reduce(
    (acc, c) => ({
      count: acc.count + 1,
      irp5: acc.irp5 + (c.kind === "IRP5" ? 1 : 0),
      it3a: acc.it3a + (c.kind === "IT3(a)" ? 1 : 0),
      payeMinor: acc.payeMinor + c.payeMinor,
      sdlMinor: acc.sdlMinor + c.sdlMinor,
      uifMinor: acc.uifMinor + c.uifMinor,
    }),
    { count: 0, irp5: 0, it3a: 0, payeMinor: 0, sdlMinor: 0, uifMinor: 0 },
  );
  const difference = {
    payeMinor: declared.payeMinor - certs.payeMinor,
    sdlMinor: declared.sdlMinor - certs.sdlMinor,
    uifMinor: declared.uifMinor - certs.uifMinor,
  };
  return {
    taxYear,
    period,
    months,
    declared,
    beforeCutOver,
    certificates: certs,
    difference,
    reconciled: difference.payeMinor === 0 && difference.sdlMinor === 0 && difference.uifMinor === 0,
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Array<Array<unknown>>): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function emp201Csv(e: Emp201, employer: { legalName: string; payeReference: string; sdlReference: string; uifReference: string }): string {
  return toCsv([
    ["EMP201 summary (evidence only, not submitted to SARS)"],
    ["Employer", employer.legalName],
    ["PAYE reference", employer.payeReference],
    ["SDL reference", employer.sdlReference],
    ["UIF reference", employer.uifReference],
    ["Month", e.month],
    ["Tax year", e.taxYear],
    ["Due date", e.dueDate],
    [],
    ["Item", "Amount (R)"],
    ["PAYE", minorToDecimal(e.payeMinor)],
    ["ETI calculated", minorToDecimal(e.etiCalculatedMinor)],
    ["ETI brought forward", minorToDecimal(e.etiBroughtForwardMinor)],
    ["ETI used", minorToDecimal(e.etiUsedMinor)],
    ["ETI carried forward", minorToDecimal(e.etiCarriedForwardMinor)],
    ["PAYE after ETI", minorToDecimal(e.payeAfterEtiMinor)],
    ["SDL", minorToDecimal(e.sdlMinor)],
    ["UIF", minorToDecimal(e.uifMinor)],
    ["Total payable", minorToDecimal(e.totalPayableMinor)],
    [],
    ["Pay runs", e.runs.join(" ")],
    ...e.notes.map((n) => ["Note", n]),
  ]);
}

/** Certificate codes as a long CSV (one row per employee per code). */
export function certificatesCsv(certs: Certificate[], employees: CertificateEmployee[]): string {
  const rows: Array<Array<unknown>> = [[
    "Tax year", "Certificate", "Employee number", "Surname", "First names", "ID number", "Passport number", "Passport country",
    "Tax reference", "Date of birth", "Period start", "Period end", "Pay periods", "IT3(a) reason (4150)", "Source code", "Amount (R)",
  ]];
  for (const cert of certs) {
    const e = employees.find((x) => x.employeeId === cert.employeeId);
    const codes = Object.keys(cert.codes).sort();
    for (const code of codes) {
      rows.push([
        cert.taxYear, cert.kind, cert.employeeNumber, e?.lastName ?? "", e?.firstName ?? "", e?.idNumber ?? "", e?.passportNumber ?? "", e?.passportCountry ?? "",
        e?.taxReference ?? "", e?.dateOfBirth ?? "", cert.periodStart, cert.periodEnd, cert.payPeriods, cert.reasonCode ?? "", code, minorToDecimal(cert.codes[code]!),
      ]);
    }
  }
  return toCsv(rows);
}

export function emp501Csv(r: Emp501): string {
  return toCsv([
    [`EMP501 reconciliation pack (${r.period}, evidence only, not submitted to SARS)`],
    ["Tax year", r.taxYear],
    [],
    ["Month", "PAYE", "ETI used", "SDL", "UIF", "Total payable"],
    ...r.months.map((m) => [m.month, minorToDecimal(m.payeMinor), minorToDecimal(m.etiUsedMinor), minorToDecimal(m.sdlMinor), minorToDecimal(m.uifMinor), minorToDecimal(m.totalPayableMinor)]),
    ["Before cut-over (openings)", minorToDecimal(r.beforeCutOver.payeMinor), minorToDecimal(r.beforeCutOver.etiMinor), minorToDecimal(r.beforeCutOver.sdlMinor), minorToDecimal(r.beforeCutOver.uifMinor), ""],
    ["Declared total", minorToDecimal(r.declared.payeMinor), minorToDecimal(r.declared.etiMinor), minorToDecimal(r.declared.sdlMinor), minorToDecimal(r.declared.uifMinor), minorToDecimal(r.declared.totalMinor)],
    [],
    ["Certificates", r.certificates.count, `IRP5 ${r.certificates.irp5}`, `IT3(a) ${r.certificates.it3a}`],
    ["Certificate totals", minorToDecimal(r.certificates.payeMinor), "", minorToDecimal(r.certificates.sdlMinor), minorToDecimal(r.certificates.uifMinor)],
    ["Difference", minorToDecimal(r.difference.payeMinor), "", minorToDecimal(r.difference.sdlMinor), minorToDecimal(r.difference.uifMinor)],
    ["Reconciled", r.reconciled ? "yes" : "no"],
  ]);
}

// ---------------------------------------------------------------------------
// YTD opening import (cut-over)
// ---------------------------------------------------------------------------

/** Minimal CSV parser (quoted fields, commas, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

export interface YtdImportRow {
  employeeNumber: string;
  codes: Record<string, number>;
  payeMinor: number;
  uifMinor: number;
  sdlMinor: number;
  etiMinor: number;
  grossMinor: number;
}

/**
 * Columns: `employee_number`, then any 4-digit SARS codes (rand amounts),
 * plus optional `eti`. PAYE, UIF and SDL come from 4102, 4141 and 4142.
 */
export function parseYtdCsv(text: string, parseRand: (v: unknown) => number | null): { rows: YtdImportRow[]; errors: string[] } {
  const table = parseCsv(text);
  const errors: string[] = [];
  if (table.length < 2) return { rows: [], errors: ["The file needs a header row and at least one employee row"] };
  const header = table[0]!.map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
  const numberCol = header.findIndex((h) => h === "employee_number" || h === "employee_no" || h === "number");
  if (numberCol < 0) return { rows: [], errors: ["Add an employee_number column"] };
  const rows: YtdImportRow[] = [];
  table.slice(1).forEach((cells, index) => {
    const employeeNumber = (cells[numberCol] ?? "").trim();
    if (!employeeNumber) {
      errors.push(`Row ${index + 2}: employee number is empty`);
      return;
    }
    const codes: Record<string, number> = {};
    let eti = 0;
    header.forEach((h, col) => {
      if (col === numberCol) return;
      const raw = (cells[col] ?? "").trim();
      if (!raw) return;
      const amount = parseRand(raw);
      if (amount == null) {
        errors.push(`Row ${index + 2}: ${h} "${raw}" is not an amount`);
        return;
      }
      if (/^\d{4}$/.test(h)) codes[h] = amount;
      else if (h === "eti") eti = amount;
    });
    let gross = 0;
    for (const [code, amount] of Object.entries(codes)) {
      const n = Number(code);
      if (n >= 3601 && n <= 3907 && !NON_TAXABLE_INCOME_CODES.has(code)) gross += amount;
    }
    rows.push({ employeeNumber, codes, payeMinor: codes["4102"] ?? 0, uifMinor: codes["4141"] ?? 0, sdlMinor: codes["4142"] ?? 0, etiMinor: eti, grossMinor: gross });
  });
  return { rows, errors };
}
