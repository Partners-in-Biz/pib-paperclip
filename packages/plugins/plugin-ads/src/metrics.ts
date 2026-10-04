/** Totals and the numbers derived from them. Money is minor units; conversions may be fractional (Google reports 2.5). */
import { ratio } from "./money.js";

export interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Conversion value in minor units (revenue the platform attributes). */
  value: number;
}

export interface Derived {
  /** clicks / impressions, 0..1 */
  ctr: number | null;
  /** Cost per click, minor units */
  cpc: number | null;
  /** Cost per thousand impressions, minor units */
  cpm: number | null;
  /** Cost per conversion, minor units */
  cpa: number | null;
  /** Conversion value / spend (3.2 means 3.20 back per 1.00 spent) */
  roas: number | null;
}

export type TotalsWithDerived = Totals & Derived;

export const emptyTotals = (): Totals => ({ spend: 0, impressions: 0, clicks: 0, conversions: 0, value: 0 });

export function addTotals(a: Totals, b: Partial<Totals>): Totals {
  return {
    spend: a.spend + (b.spend ?? 0),
    impressions: a.impressions + (b.impressions ?? 0),
    clicks: a.clicks + (b.clicks ?? 0),
    conversions: round2(a.conversions + (b.conversions ?? 0)),
    value: a.value + (b.value ?? 0),
  };
}

export function sumRows(rows: Array<Partial<Totals>>): Totals {
  return rows.reduce<Totals>((acc, row) => addTotals(acc, row), emptyTotals());
}

export function derive(t: Totals): Derived {
  const cpc = ratio(t.spend, t.clicks);
  const cpm = ratio(t.spend * 1000, t.impressions);
  const cpa = ratio(t.spend, t.conversions);
  const roas = ratio(t.value, t.spend);
  return {
    ctr: ratio(t.clicks, t.impressions),
    cpc: cpc === null ? null : Math.round(cpc),
    cpm: cpm === null ? null : Math.round(cpm),
    cpa: cpa === null ? null : Math.round(cpa),
    roas: roas === null ? null : Math.round(roas * 100) / 100,
  };
}

export function withDerived(t: Totals): TotalsWithDerived {
  return { ...t, ...derive(t) };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Change from `before` to `after` as a fraction (0.25 is +25%); null when there is nothing to compare with. */
export function change(before: number | null, after: number | null): number | null {
  if (before === null || after === null || before === 0) return null;
  return (after - before) / before;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
