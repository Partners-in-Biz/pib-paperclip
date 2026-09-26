/**
 * Employee personal details that must never sit in plaintext rows, traces,
 * tool output or logs: ID / passport number, tax reference number and bank
 * details. They are sealed with AES-256-GCM (kit `crypto.ts`) under the
 * company's payroll encryption key and opened only to run payroll, build a
 * payslip or bank file, or for a board user's "Reveal".
 *
 * Everywhere else the masks are used (last digits only).
 */
import { buildKeyring, openJson, sealJson, type TokenKeyring } from "@partnersinbiz/pib-plugin-kit";
import { PayrollError } from "./money.js";

export interface IdentityDetails {
  idNumber: string | null;
  passportNumber: string | null;
  passportCountry: string | null;
}

export interface TaxDetails {
  taxReference: string | null;
}

export interface BankDetails {
  bankName: string;
  branchCode: string;
  accountNumber: string;
  accountType: "current" | "savings" | "transmission";
  accountHolder: string;
}

export interface PiiMasks {
  idNumber: string | null;
  passportNumber: string | null;
  taxReference: string | null;
  bankName: string | null;
  accountNumber: string | null;
  accountType: string | null;
}

export const EMPTY_MASKS: PiiMasks = { idNumber: null, passportNumber: null, taxReference: null, bankName: null, accountNumber: null, accountType: null };

export const PII_FIELDS = ["identity", "tax", "bank"] as const;
export type PiiField = (typeof PII_FIELDS)[number];

export function payrollKeyring(companyId: string, secret: string, previous?: { version: number; secret: string } | null, version = 1): TokenKeyring {
  return buildKeyring({ purpose: "payroll-pii", companyId, secret, version, previous: previous ? [previous] : [] });
}

export function sealDetails(value: IdentityDetails | TaxDetails | BankDetails, keyring: TokenKeyring): string {
  return sealJson(value, keyring);
}

export function openDetails<T>(sealed: string | null | undefined, keyring: TokenKeyring): T | null {
  if (!sealed) return null;
  return openJson<T>(sealed, keyring);
}

/** "••••1234": keeps the last `keep` characters. */
export function maskTail(value: string | null | undefined, keep = 4): string | null {
  const text = String(value ?? "").replace(/\s+/g, "");
  if (!text) return null;
  if (text.length <= keep) return "•".repeat(text.length);
  return `${"•".repeat(Math.min(6, text.length - keep))}${text.slice(-keep)}`;
}

export function masksFor(identity: IdentityDetails | null, tax: TaxDetails | null, bank: BankDetails | null, current: PiiMasks = EMPTY_MASKS): PiiMasks {
  return {
    idNumber: identity ? maskTail(identity.idNumber, 3) : current.idNumber,
    passportNumber: identity ? maskTail(identity.passportNumber, 3) : current.passportNumber,
    taxReference: tax ? maskTail(tax.taxReference, 3) : current.taxReference,
    bankName: bank ? bank.bankName : current.bankName,
    accountNumber: bank ? maskTail(bank.accountNumber, 4) : current.accountNumber,
    accountType: bank ? bank.accountType : current.accountType,
  };
}

/** Luhn check used by South African ID numbers. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Validates a 13-digit SA ID number; returns the date of birth it encodes (YYYY-MM-DD) when valid. */
export function validateSaId(value: string, referenceYear = new Date().getUTCFullYear()): { valid: boolean; dateOfBirth: string | null; reason?: string } {
  const digits = value.replace(/\s+/g, "");
  if (!/^\d{13}$/.test(digits)) return { valid: false, dateOfBirth: null, reason: "An SA ID number has 13 digits" };
  if (!luhnValid(digits)) return { valid: false, dateOfBirth: null, reason: "The ID number's check digit is wrong" };
  const yy = Number(digits.slice(0, 2));
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  const century = yy + 2000 <= referenceYear ? 2000 : 1900;
  const date = new Date(Date.UTC(century + yy, mm - 1, dd));
  if (date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return { valid: false, dateOfBirth: null, reason: "The ID number does not start with a real date" };
  return { valid: true, dateOfBirth: date.toISOString().slice(0, 10) };
}

/** SARS income tax reference: 10 digits starting with 0, 1, 2, 3 or 9. */
export function validateTaxReference(value: string): boolean {
  return /^[01239]\d{9}$/.test(value.replace(/\s+/g, ""));
}

export function normaliseIdentity(input: Record<string, unknown>): IdentityDetails {
  const idNumber = digitsOrNull(input.idNumber);
  const passportNumber = textOrNull(input.passportNumber, 20)?.toUpperCase() ?? null;
  const passportCountry = textOrNull(input.passportCountry, 3)?.toUpperCase() ?? null;
  if (idNumber) {
    const check = validateSaId(idNumber);
    if (!check.valid) throw new PayrollError(check.reason ?? "The ID number is not valid");
  }
  if (!idNumber && !passportNumber) throw new PayrollError("Enter an SA ID number or a passport number");
  return { idNumber, passportNumber, passportCountry };
}

export function normaliseTax(input: Record<string, unknown>): TaxDetails {
  const taxReference = digitsOrNull(input.taxReference);
  if (taxReference && !validateTaxReference(taxReference)) throw new PayrollError("A tax reference number has 10 digits and starts with 0, 1, 2, 3 or 9");
  return { taxReference };
}

export function normaliseBank(input: Record<string, unknown>): BankDetails {
  const bankName = textOrNull(input.bankName, 60);
  const branchCode = digitsOrNull(input.branchCode);
  const accountNumber = digitsOrNull(input.accountNumber);
  const accountHolder = textOrNull(input.accountHolder, 80);
  const type = String(input.accountType ?? "current").toLowerCase();
  if (!bankName) throw new PayrollError("Bank name is required");
  if (!branchCode || branchCode.length !== 6) throw new PayrollError("The branch code must be 6 digits");
  if (!accountNumber || accountNumber.length < 6 || accountNumber.length > 16) throw new PayrollError("The account number must be 6 to 16 digits");
  if (!accountHolder) throw new PayrollError("Account holder name is required");
  const accountType = type.startsWith("sav") ? "savings" : type.startsWith("trans") ? "transmission" : "current";
  return { bankName, branchCode, accountNumber, accountType, accountHolder };
}

function digitsOrNull(value: unknown): string | null {
  if (value == null) return null;
  const digits = String(value).replace(/[\s-]+/g, "");
  if (!digits) return null;
  if (!/^\d+$/.test(digits)) throw new PayrollError("Use digits only for ID, tax and bank numbers");
  return digits;
}

function textOrNull(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Throws when any of the plaintext values appears in `payload` (used to
 * guard tool output and logs). Values shorter than 5 characters are skipped.
 */
export function assertNoPlaintext(payload: unknown, secrets: Array<string | null | undefined>): void {
  const text = JSON.stringify(payload ?? null);
  for (const secret of secrets) {
    if (!secret || secret.length < 5) continue;
    if (text.includes(secret)) throw new PayrollError("Refusing to return unmasked personal details");
  }
}
