/**
 * Money is integer minor units (cents) in the ad account's own currency, never floats.
 * Meta reports spend as a decimal string in major units and takes budgets in minor units;
 * Google reports cost in micros (millionths of the major unit). Both land here as minor units.
 */

const ZERO_DECIMAL = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"]);
const THREE_DECIMAL = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

/** Decimal places of a currency's minor unit (2 for most, 0 for yen, 3 for dinar). */
export function currencyExponent(currency: string | null | undefined): number {
  const code = (currency ?? "").toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** `"12.34"` (major units) to minor units, rounding half up; null when it is not a plain decimal. */
export function decimalToMinor(value: unknown, currency: string | null | undefined): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const exponent = currencyExponent(currency);
  const [, sign, whole, fraction = ""] = match;
  const padded = fraction.padEnd(exponent + 1, "0");
  let minor = BigInt(whole! + padded.slice(0, exponent));
  if (padded.charCodeAt(exponent) >= 53) minor += 1n; // the next digit is 5 or more
  const result = Number(minor);
  return sign ? -result : result;
}

/** Google's `costMicros` (a string or number) to minor units. */
export function microsToMinor(micros: unknown, currency: string | null | undefined): number {
  const n = typeof micros === "string" ? Number(micros) : typeof micros === "number" ? micros : 0;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n / 10 ** (6 - currencyExponent(currency)));
}

/** Minor units to Google micros. */
export function minorToMicros(minor: number, currency: string | null | undefined): number {
  return Math.round(minor * 10 ** (6 - currencyExponent(currency)));
}

/** `R 1 234,50`-style text for people: the currency code and a grouped amount, e.g. `ZAR 1,234.50`. */
export function formatMoney(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return "n/a";
  const exponent = currencyExponent(currency);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(Math.round(minor));
  const scale = 10 ** exponent;
  const whole = Math.floor(abs / scale);
  const fraction = exponent ? `.${String(abs % scale).padStart(exponent, "0")}` : "";
  return `${sign}${(currency ?? "").toUpperCase()} ${whole.toLocaleString("en-US")}${fraction}`.trim();
}

/** `n / d`, or null when the denominator is zero or either side is not a number. */
export function ratio(n: number, d: number): number | null {
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d;
}

/** A whole number from a driver value (bigint columns arrive as strings); 0 when it is not one. */
export function toInt(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** A decimal number from a driver value (numeric columns arrive as strings); 0 when it is not one. */
export function toNum(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Percentage text `12.3%` from a 0..1 fraction. */
export function pct(fraction: number | null | undefined, digits = 0): string {
  return fraction === null || fraction === undefined || !Number.isFinite(fraction) ? "n/a" : `${(fraction * 100).toFixed(digits)}%`;
}
