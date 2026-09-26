/**
 * Document money: per-line VAT codes, VAT-inclusive or exclusive prices,
 * totals per line and per VAT code. All amounts are integer minor units.
 *
 * Two regimes, so totals of existing invoices never change:
 * - Legacy (no line has a VAT code): VAT is the document rate on the
 *   subtotal, rounded once (`totalWithTax`), exactly as before 0.3.
 * - Coded (any line has a code): VAT per line from its code; lines without a
 *   code use the document rate. Totals are the sums of the lines.
 */
import { TAX_CODES, type TaxCode } from "@partnersinbiz/pib-plugin-kit";
import { BillingError, totalWithTax } from "./domain.js";

export interface MoneyLine {
  quantity: number;
  unitAmountMinor: number;
  taxCode?: string | null;
}

export interface LineAmounts {
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
  /** Basis points, 1500 = 15%. */
  rateBp: number;
  taxCode: TaxCode | null;
}

export interface TaxGroup {
  taxCode: TaxCode | null;
  rateBp: number;
  netMinor: number;
  vatMinor: number;
  grossMinor: number;
}

export interface DocumentTotals {
  lines: LineAmounts[];
  groups: TaxGroup[];
  subtotalMinor: number;
  vatMinor: number;
  totalMinor: number;
  legacy: boolean;
}

export function isTaxCodeValue(value: unknown): value is TaxCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TAX_CODES, value);
}

export function assertTaxCode(value: unknown): TaxCode {
  if (!isTaxCodeValue(value)) {
    throw new BillingError(`VAT code must be one of ${Object.keys(TAX_CODES).join(", ")}`);
  }
  return value;
}

export function taxLabel(code: TaxCode | null, rateBp: number): string {
  if (code) return TAX_CODES[code].label;
  return rateBp > 0 ? `VAT ${rateBp / 100}%` : "No VAT";
}

function codeBp(code: TaxCode): number {
  return Math.round(TAX_CODES[code].rate * 10_000);
}

function percentBp(percent: number): number {
  const value = Number(percent ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
}

/** Legacy document rate → the VAT code it stands for (15% → za_std_15, 0 → none). */
export function legacyTaxCode(ratePercent: number): TaxCode | null {
  const bp = percentBp(ratePercent);
  if (bp === 1500) return "za_std_15";
  return null;
}

/** Round a / b half up (a, b ≥ 0). */
export function roundDiv(a: number, b: number): number {
  return Math.floor((2 * a + b) / (2 * b));
}

function assertLine(line: MoneyLine): void {
  if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new BillingError("Quantity must be a positive integer");
  if (!Number.isInteger(line.unitAmountMinor) || line.unitAmountMinor < 0) {
    throw new BillingError("Unit amount must be a non-negative integer in minor units");
  }
}

export function computeLine(line: MoneyLine, options: { pricesIncludeVat?: boolean; taxRatePercent?: number }): LineAmounts {
  assertLine(line);
  const taxCode = isTaxCodeValue(line.taxCode) ? line.taxCode : null;
  const rateBp = taxCode ? codeBp(taxCode) : percentBp(options.taxRatePercent ?? 0);
  const amount = line.quantity * line.unitAmountMinor;
  if (options.pricesIncludeVat) {
    const vatMinor = rateBp > 0 ? roundDiv(amount * rateBp, 10_000 + rateBp) : 0;
    return { netMinor: amount - vatMinor, vatMinor, grossMinor: amount, rateBp, taxCode };
  }
  const vatMinor = rateBp > 0 ? roundDiv(amount * rateBp, 10_000) : 0;
  return { netMinor: amount, vatMinor, grossMinor: amount + vatMinor, rateBp, taxCode };
}

/** Split `total` across `weights` so the parts add up exactly (largest remainder). */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (weights.length === 0) return [];
  if (sum <= 0) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const raw = weights.map((w) => (total * Math.max(0, w)) / sum);
  const floors = raw.map((r) => Math.floor(r));
  let rest = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (rest <= 0) break;
    floors[i]! += 1;
    rest -= 1;
  }
  return floors;
}

function groupsOf(lines: LineAmounts[]): TaxGroup[] {
  const map = new Map<string, TaxGroup>();
  for (const line of lines) {
    const key = `${line.taxCode ?? ""}:${line.rateBp}`;
    const group = map.get(key) ?? { taxCode: line.taxCode, rateBp: line.rateBp, netMinor: 0, vatMinor: 0, grossMinor: 0 };
    group.netMinor += line.netMinor;
    group.vatMinor += line.vatMinor;
    group.grossMinor += line.grossMinor;
    map.set(key, group);
  }
  return [...map.values()];
}

export function computeDocument(lines: MoneyLine[], options: { pricesIncludeVat?: boolean; taxRatePercent?: number }): DocumentTotals {
  lines.forEach(assertLine);
  const coded = lines.some((line) => isTaxCodeValue(line.taxCode));
  if (!coded) {
    const rate = Number(options.taxRatePercent ?? 0);
    const rateBp = percentBp(rate);
    const taxCode = legacyTaxCode(rate);
    const amounts = lines.map((line) => line.quantity * line.unitAmountMinor);
    const sum = amounts.reduce((a, b) => a + b, 0);
    let subtotalMinor: number;
    let vatMinor: number;
    if (options.pricesIncludeVat) {
      vatMinor = rateBp > 0 ? roundDiv(sum * rateBp, 10_000 + rateBp) : 0;
      subtotalMinor = sum - vatMinor;
    } else {
      subtotalMinor = sum;
      vatMinor = totalWithTax(sum, rate).taxMinor;
    }
    const vatParts = allocate(vatMinor, amounts);
    const out = amounts.map((amount, i) => {
      const vat = vatParts[i] ?? 0;
      return options.pricesIncludeVat
        ? { netMinor: amount - vat, vatMinor: vat, grossMinor: amount, rateBp, taxCode }
        : { netMinor: amount, vatMinor: vat, grossMinor: amount + vat, rateBp, taxCode };
    });
    return {
      lines: out,
      groups: out.length ? [{ taxCode, rateBp, netMinor: subtotalMinor, vatMinor, grossMinor: subtotalMinor + vatMinor }] : [],
      subtotalMinor,
      vatMinor,
      totalMinor: subtotalMinor + vatMinor,
      legacy: true,
    };
  }
  const out = lines.map((line) => computeLine(line, options));
  const subtotalMinor = out.reduce((a, l) => a + l.netMinor, 0);
  const vatMinor = out.reduce((a, l) => a + l.vatMinor, 0);
  return { lines: out, groups: groupsOf(out), subtotalMinor, vatMinor, totalMinor: subtotalMinor + vatMinor, legacy: false };
}

/**
 * Split a VAT-inclusive amount (a credit note, a write-off) over a document's
 * VAT groups in proportion to their gross, so VAT reverses at the rate it
 * was charged.
 */
export function splitByGroups(amountMinor: number, groups: TaxGroup[]): TaxGroup[] {
  if (groups.length === 0) return [{ taxCode: null, rateBp: 0, netMinor: amountMinor, vatMinor: 0, grossMinor: amountMinor }];
  const grossParts = allocate(amountMinor, groups.map((g) => g.grossMinor));
  return groups.map((group, i) => {
    const gross = grossParts[i] ?? 0;
    const vat = group.grossMinor > 0 ? roundDiv(gross * group.vatMinor, group.grossMinor) : 0;
    return { taxCode: group.taxCode, rateBp: group.rateBp, netMinor: gross - vat, vatMinor: vat, grossMinor: gross };
  }).filter((group) => group.grossMinor > 0);
}

/** "1 234,50" / "1234.5" / "R 99" → minor units. */
export function parseMoneyToMinor(value: string): number {
  const cleaned = String(value).replace(/[^\d,.-]/g, "").replace(/,(?=\d{1,2}$)/, ".").replace(/,/g, "");
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) throw new BillingError("Enter a valid amount");
  return Math.round(amount * 100);
}

export function monthlyMinor(priceMinor: number, period: string): number {
  if (period === "quarterly") return Math.round(priceMinor / 3);
  if (period === "yearly") return Math.round(priceMinor / 12);
  return priceMinor;
}
