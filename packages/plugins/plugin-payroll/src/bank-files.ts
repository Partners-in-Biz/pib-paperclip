/**
 * Net-pay bank batch files (ACB-style and NetCash-style), ported from the old
 * platform's `lib/finance/packaging/sa-bank-formats.ts`.
 *
 * DOWNLOAD ONLY. Building a file never pays anyone: a person downloads it
 * and uploads it in the bank's own channel. The files hold account numbers,
 * so they are built only on a board user's request and stored in the
 * private bucket.
 */
import { createHash } from "node:crypto";
import { minorToDecimal, PayrollError } from "./money.js";

export interface BankPaymentRow {
  beneficiaryName: string;
  bankName?: string | null;
  accountNumber: string;
  branchCode: string;
  /** current / cheque / savings / transmission, or 1 / 2 / 3. */
  accountType?: string | number | null;
  amountMinor: number;
  /** Shown on the employee's statement, e.g. "SALARY SEP 2026". */
  reference: string;
  /** Employer-side reference, e.g. the employee number. */
  ownReference?: string | null;
  /** YYYY-MM-DD. */
  actionDate: string;
}

export interface BankFile {
  name: string;
  contentType: string;
  content: string;
  sha256: string;
  rows: number;
  totalMinor: number;
}

export type BankFormat = "acb" | "netcash";

export const BANK_FILE_NOTICE =
  "DOWNLOAD ONLY. Upload this file yourself in your bank's channel. Paperclip never makes payments or logs in to a bank.";

function digitsOnly(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** 1 = current/cheque, 2 = savings, 3 = transmission (SA convention). */
export function accountTypeCode(value: unknown): "1" | "2" | "3" {
  const raw = String(value ?? "1").trim();
  if (raw === "2" || /^sav/i.test(raw)) return "2";
  if (raw === "3" || /^trans/i.test(raw)) return "3";
  return "1";
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/[\r\n|]+/g, " ").trim().slice(0, max);
}

function finish(name: string, contentType: string, lines: string[], rows: BankPaymentRow[]): BankFile {
  const content = `${lines.join("\n")}\n`;
  return {
    name,
    contentType,
    content,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    rows: rows.length,
    totalMinor: rows.reduce((sum, row) => sum + row.amountMinor, 0),
  };
}

/** Rows must have a 6-digit branch code, an account number and a positive amount. */
export function validateBankRows(rows: BankPaymentRow[]): string[] {
  const problems: string[] = [];
  rows.forEach((row, i) => {
    const who = row.ownReference || `row ${i + 1}`;
    if (digitsOnly(row.branchCode).length !== 6) problems.push(`${who}: the branch code must be 6 digits`);
    const account = digitsOnly(row.accountNumber);
    if (account.length < 6 || account.length > 16) problems.push(`${who}: the account number must be 6 to 16 digits`);
    if (!Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0) problems.push(`${who}: the amount must be more than zero`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.actionDate)) problems.push(`${who}: the action date must be YYYY-MM-DD`);
  });
  return problems;
}

/**
 * ACB-style CSV used by many SA bulk EFT upload screens. Record type 10 is a
 * credit detail line. Columns are fixed so snapshot tests can pin them.
 */
export function buildAcbCsv(rows: BankPaymentRow[], fileName = "acb-batch.csv"): BankFile {
  const header = [
    "RecordType",
    "BranchCode",
    "AccountNumber",
    "AccountType",
    "AmountCents",
    "Amount",
    "ActionDate",
    "BeneficiaryName",
    "StatementReference",
    "OwnReference",
    "BankName",
    "Currency",
  ];
  const lines = [`# ACB-style EFT batch (payroll)`, `# ${BANK_FILE_NOTICE}`, header.join(",")];
  rows.forEach((row, i) => {
    lines.push([
      "10",
      digitsOnly(row.branchCode).slice(0, 6),
      digitsOnly(row.accountNumber).slice(0, 16),
      accountTypeCode(row.accountType),
      String(row.amountMinor),
      minorToDecimal(row.amountMinor),
      row.actionDate.replace(/-/g, ""),
      csvEscape(clean(row.beneficiaryName, 30) || "BENEFICIARY"),
      csvEscape(clean(row.reference, 20) || "SALARY"),
      csvEscape(clean(row.ownReference, 20) || `ROW${i + 1}`),
      csvEscape(clean(row.bankName, 30)),
      "ZAR",
    ].join(","));
  });
  return finish(fileName, "text/csv; charset=utf-8", lines, rows);
}

/** ACB-style pipe-delimited text with header, detail and trailer records. */
export function buildAcbTxt(rows: BankPaymentRow[], fileName = "acb-batch.txt"): BankFile {
  const lines = ["H|ACB|payroll|DOWNLOAD_ONLY", `N|${BANK_FILE_NOTICE}`];
  rows.forEach((row, i) => {
    lines.push([
      "D",
      "10",
      digitsOnly(row.branchCode).slice(0, 6),
      digitsOnly(row.accountNumber).slice(0, 16),
      accountTypeCode(row.accountType),
      String(row.amountMinor),
      row.actionDate.replace(/-/g, ""),
      clean(row.beneficiaryName, 30) || "BENEFICIARY",
      clean(row.reference, 20) || "SALARY",
      clean(row.ownReference, 20) || `ROW${i + 1}`,
      "ZAR",
    ].join("|"));
  });
  const total = rows.reduce((sum, row) => sum + row.amountMinor, 0);
  lines.push(`T|${rows.length}|${total}`);
  return finish(fileName, "text/plain; charset=utf-8", lines, rows);
}

/** NetCash-style CSV batch. Amounts in rand with two decimals; account type 1 = current, 2 = savings. */
export function buildNetCashCsv(rows: BankPaymentRow[], fileName = "netcash-batch.csv"): BankFile {
  const header = ["Account reference", "Name", "Branch code", "Account number", "Account type", "Amount", "Extra 1", "Extra 2", "Email notification", "Mobile notification"];
  const lines = [`# NetCash-style batch (payroll)`, `# ${BANK_FILE_NOTICE}`, header.join(",")];
  rows.forEach((row, i) => {
    lines.push([
      csvEscape(clean(row.ownReference, 20) || `ROW${i + 1}`),
      csvEscape(clean(row.beneficiaryName, 50) || "BENEFICIARY"),
      digitsOnly(row.branchCode).slice(0, 6),
      digitsOnly(row.accountNumber).slice(0, 16),
      accountTypeCode(row.accountType),
      minorToDecimal(row.amountMinor),
      csvEscape(clean(row.reference, 30) || "SALARY"),
      csvEscape(clean(row.bankName, 30)),
      "",
      "",
    ].join(","));
  });
  return finish(fileName, "text/csv; charset=utf-8", lines, rows);
}

export function buildBankFile(format: BankFormat, rows: BankPaymentRow[], baseName: string): BankFile {
  const problems = validateBankRows(rows);
  if (problems.length) throw new PayrollError(`The bank file cannot be built: ${problems.join("; ")}`);
  if (format === "acb") return buildAcbCsv(rows, `${baseName}-acb.csv`);
  if (format === "netcash") return buildNetCashCsv(rows, `${baseName}-netcash.csv`);
  throw new PayrollError("Bank file format must be acb or netcash");
}
