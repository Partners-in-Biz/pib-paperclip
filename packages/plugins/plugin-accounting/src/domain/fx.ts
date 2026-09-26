/**
 * FX revaluation of open foreign-currency receivables and payables at a
 * period end. Unrealised gain/loss = outstanding × (closing rate − booked
 * rate), in book cents. The journal is reversed on the first day of the next
 * period, so each revaluation starts again from the booked rate and realised
 * FX (posted by Billing when an item is paid) is never double counted.
 */
import { AccountingError } from "./util.js";

export interface FxItem {
  key: string;
  kind: "receivable" | "payable";
  number: string;
  currency: string;
  outstandingMinor: number;
  /** Book units per 1 foreign unit when the item was posted. */
  bookedRate: number;
}

export interface FxRevaluationLine {
  role: "ar" | "ap" | "fx_gain" | "fx_loss";
  debitMinor: number;
  creditMinor: number;
  memo: string;
}

export interface FxRevaluation {
  lines: FxRevaluationLine[];
  items: Array<FxItem & { closingRate: number; bookedMinor: number; revaluedMinor: number; differenceMinor: number }>;
  gainMinor: number;
  lossMinor: number;
  skipped: Array<{ key: string; reason: string }>;
}

export function revalue(items: FxItem[], closingRates: ReadonlyMap<string, number>): FxRevaluation {
  const out: FxRevaluation = { lines: [], items: [], gainMinor: 0, lossMinor: 0, skipped: [] };
  for (const item of items) {
    const closing = closingRates.get(item.currency);
    if (!closing || !(closing > 0)) {
      out.skipped.push({ key: item.key, reason: `No ${item.currency} rate for the period end` });
      continue;
    }
    if (!(item.bookedRate > 0)) {
      out.skipped.push({ key: item.key, reason: "The booked rate is not known (no posted journal with a rate)" });
      continue;
    }
    const bookedMinor = Math.round(item.outstandingMinor * item.bookedRate);
    const revaluedMinor = Math.round(item.outstandingMinor * closing);
    const diff = revaluedMinor - bookedMinor;
    out.items.push({ ...item, closingRate: closing, bookedMinor, revaluedMinor, differenceMinor: diff });
    if (diff === 0) continue;
    const memo = `${item.number} ${item.currency} ${item.bookedRate} → ${closing}`;
    // Receivable worth more = gain; payable worth more = loss.
    const gain = item.kind === "receivable" ? diff > 0 : diff < 0;
    const abs = Math.abs(diff);
    if (item.kind === "receivable") {
      out.lines.push({ role: "ar", debitMinor: diff > 0 ? abs : 0, creditMinor: diff < 0 ? abs : 0, memo });
    } else {
      out.lines.push({ role: "ap", debitMinor: diff < 0 ? abs : 0, creditMinor: diff > 0 ? abs : 0, memo });
    }
    if (gain) out.gainMinor += abs;
    else out.lossMinor += abs;
  }
  if (out.gainMinor > 0) out.lines.push({ role: "fx_gain", debitMinor: 0, creditMinor: out.gainMinor, memo: "Unrealised FX gain" });
  if (out.lossMinor > 0) out.lines.push({ role: "fx_loss", debitMinor: out.lossMinor, creditMinor: 0, memo: "Unrealised FX loss" });
  return out;
}

/** Frankfurter answers "1 ZAR = x USD"; we store "1 USD = 1/x ZAR". */
export function invertRates(rates: Record<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [currency, value] of Object.entries(rates)) {
    if (typeof value === "number" && value > 0) out.set(currency, Number((1 / value).toPrecision(10)));
  }
  return out;
}

export function parseFrankfurter(body: unknown): { date: string; base: string; rates: Record<string, number> } {
  if (!body || typeof body !== "object") throw new AccountingError("FX rates response was not JSON");
  const b = body as { date?: unknown; base?: unknown; rates?: unknown };
  if (typeof b.date !== "string" || !b.rates || typeof b.rates !== "object") throw new AccountingError("FX rates response had no date or rates");
  return { date: b.date, base: typeof b.base === "string" ? b.base : "ZAR", rates: b.rates as Record<string, number> };
}
