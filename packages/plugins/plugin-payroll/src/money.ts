/**
 * Integer money helpers. Every amount is integer minor units (cents); rates
 * are basis points (1 bp = 0.01%, so 18% = 1800 and 1% = 100); hours are
 * centi-hours (160 hours = 16000). Rounding is half away from zero.
 */

export class PayrollError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollError";
  }
}

export function assertMinor(value: number, field: string, allowNegative = false): number {
  if (!Number.isSafeInteger(value) || (!allowNegative && value < 0)) {
    throw new PayrollError(`${field} must be ${allowNegative ? "a whole number of cents" : "zero or more cents"}`);
  }
  return value;
}

/** numerator / denominator rounded half away from zero. */
export function divRound(numerator: number, denominator: number): number {
  if (!Number.isFinite(denominator) || denominator <= 0) throw new PayrollError("Division by a non-positive number");
  if (numerator === 0) return 0;
  const sign = numerator < 0 ? -1 : 1;
  const abs = Math.abs(numerator);
  const result = sign * Math.floor((abs + Math.floor(denominator / 2)) / denominator);
  if (!Number.isSafeInteger(result)) throw new PayrollError("Amount is too large");
  return result;
}

/** amount × bp / 10 000, rounded. */
export function applyBp(amountMinor: number, bp: number): number {
  return divRound(amountMinor * bp, 10_000);
}

/** amount × hoursCenti / 100, rounded (rate per hour times hours). */
export function timesHours(rateMinor: number, hoursCenti: number): number {
  return divRound(rateMinor * hoursCenti, 100);
}

/** Hours as centi-hours from a decimal number of hours (e.g. 7.5 → 750). */
export function toCentiHours(hours: number | null | undefined): number {
  if (hours == null) return 0;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours < 0) throw new PayrollError("Hours must be zero or more");
  return Math.round(hours * 100);
}

/** Rand text (e.g. "1234.5", "R 1 234,50", "1,234.50") to cents. */
export function parseRandToMinor(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/^R\s*/i, "").replace(/\s+/g, "");
  if (!text) return null;
  const negative = text.startsWith("-") || (text.startsWith("(") && text.endsWith(")"));
  text = text.replace(/[()\-]/g, "");
  if (/,\d{1,2}$/.test(text) && !/\.\d/.test(text)) text = text.replace(/\./g, "").replace(",", ".");
  text = text.replace(/,/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return negative ? -cents : cents;
}

/** Cents as "1234.56" (no symbol, no thousands separator). */
export function minorToDecimal(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(minor));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Cents as "R 12,345.67". */
export function formatRand(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}R ${whole}.${String(abs % 100).padStart(2, "0")}`;
}
