/**
 * VAT201 return built from journal lines' taxCode + taxBaseMinor.
 *
 * Field numbers and meanings follow SARS "Guide for Completing the
 * Value-Added Tax (VAT201) Declaration" (GEN-ELEC-04-G01) and
 * https://www.sars.gov.za/guide-to-completing-the-value-added-tax-vat201-return/
 * (checked 2026-09-26):
 *  1  Standard-rated supplies (excl. capital goods), VAT-inclusive consideration; 4 = 1 × 15/115
 *  1A Standard-rated supplies of capital goods, VAT-inclusive;                    4A = 1A × 15/115
 *  2  Zero-rated supplies (excl. exports)      2A Zero-rated exports
 *  3  Exempt and non-supplies
 *  5–9 Commercial accommodation (not used by PiB; always 0)
 *  10 Change in use / exported second-hand goods (VAT-inclusive);                11 = 10 × 15/115
 *  12 Other and imported services (VAT on credit notes received, bad debts recovered, …)
 *  13 Total output tax = 4 + 4A + 9 + 11 + 12
 *  14 Input tax: capital goods and services supplied to you  14A imported capital goods
 *  15 Input tax: other goods and services (not capital)      15A imported goods (not capital)
 *  16 Change in use adjustments  17 Bad debts  18 Other adjustments (credit notes issued, …)
 *  19 Total input tax = 14 + 14A + 15 + 15A + 16 + 17 + 18
 *  20 VAT payable (positive) or refundable (negative) = 13 − 19
 *
 * How lines are read:
 * - Lines on a VAT output / VAT input account carry the tax. Their sign
 *   comes from the posting (output: credit − debit; input: debit − credit),
 *   so reversals net off. Their taxBaseMinor (when given) is the net base.
 * - Other income / expense / fixed-asset lines with a taxCode are the base
 *   when no VAT line in the same journal gives one (and they are the only
 *   evidence for zero-rated and exempt supplies).
 * - Journals whose source kind is a credit note go to the adjustment
 *   fields: VAT on credit notes issued → 18, on credit notes received → 12.
 *   Output VAT reversed in a bad-debt write-off → 17.
 * Imports (14A/15A) and accommodation (5–9) are not separated by the kit's
 * tax codes; enter them as manual adjustments when they apply.
 */
import type { AccountSubtype, AccountType } from "./chart.js";

export type VatField =
  | "f1" | "f1A" | "f2" | "f2A" | "f3" | "f4" | "f4A" | "f5" | "f6" | "f7" | "f8" | "f9"
  | "f10" | "f11" | "f12" | "f13" | "f14" | "f14A" | "f15" | "f15A" | "f16" | "f17" | "f18" | "f19" | "f20";

export type VatBoxes = Record<VatField, number>;

export const VAT_FIELD_LABELS: Record<VatField, string> = {
  f1: "1 Standard rate (excl. capital goods) – incl. VAT",
  f1A: "1A Standard rate capital goods – incl. VAT",
  f2: "2 Zero rate (excl. exports)",
  f2A: "2A Zero rate exports",
  f3: "3 Exempt and non-supplies",
  f4: "4 Output tax on field 1",
  f4A: "4A Output tax on field 1A",
  f5: "5 Accommodation > 28 days",
  f6: "6 Deemed supply (60% of 5)",
  f7: "7 Accommodation ≤ 28 days",
  f8: "8 Total accommodation (6 + 7)",
  f9: "9 Output tax on accommodation",
  f10: "10 Change in use and export of second-hand goods",
  f11: "11 Output tax on field 10",
  f12: "12 Other and imported services",
  f13: "13 Total output tax",
  f14: "14 Capital goods and services supplied to you",
  f14A: "14A Capital goods imported",
  f15: "15 Other goods and services supplied to you",
  f15A: "15A Other goods imported",
  f16: "16 Change in use",
  f17: "17 Bad debts",
  f18: "18 Other adjustments",
  f19: "19 Total input tax",
  f20: "20 VAT payable / (refundable)",
};

export const VAT_FIELDS = Object.keys(VAT_FIELD_LABELS) as VatField[];

/** Fields a person may enter by hand (everything else is computed). */
export const MANUAL_VAT_FIELDS = ["f10", "f12", "f14A", "f15A", "f16", "f17", "f18"] as const;
export type ManualVatField = (typeof MANUAL_VAT_FIELDS)[number];

export interface VatSourceLine {
  journalId: string;
  journalNumber: string;
  sourceKind: string | null;
  accountType: AccountType;
  accountSubtype: AccountSubtype;
  isBadDebtAccount: boolean;
  debitMinor: number;
  creditMinor: number;
  taxCode: string | null;
  taxBaseMinor: number | null;
}

export interface VatDetailRow {
  direction: "output" | "input";
  taxCode: string;
  baseMinor: number;
  taxMinor: number;
  journals: number;
  field: string;
}

export interface VatReturnResult {
  boxes: VatBoxes;
  detail: VatDetailRow[];
  warnings: string[];
}

export function emptyBoxes(): VatBoxes {
  return Object.fromEntries(VAT_FIELDS.map((f) => [f, 0])) as VatBoxes;
}

const RATE_BPS: Record<string, number> = { za_std_15: 1500, za_capital_15: 1500 };

export function isCreditNoteKind(kind: string | null | undefined): boolean {
  return /credit[\s_-]?note|creditnote/i.test(kind ?? "");
}

function isVatAccount(subtype: AccountSubtype): "output" | "input" | null {
  if (subtype === "vat_output") return "output";
  if (subtype === "vat_input") return "input";
  return null;
}

type Group = { direction: "output" | "input"; code: string; tax: number; vatBase: number | null; lineBase: number; hasLineBase: boolean };

/**
 * Compute the VAT201 boxes. `rateBpsFor(code)` gives the rate used only to
 * estimate a missing base; the tax itself always comes from the posted VAT.
 */
export function computeVatReturn(
  lines: VatSourceLine[],
  manual: Partial<Record<ManualVatField, number>> = {},
  rateBpsFor: (code: string) => number = (code) => RATE_BPS[code] ?? 0,
): VatReturnResult {
  const byJournal = new Map<string, VatSourceLine[]>();
  for (const line of lines) {
    const list = byJournal.get(line.journalId) ?? [];
    list.push(line);
    byJournal.set(line.journalId, list);
  }
  const boxes = emptyBoxes();
  const detail = new Map<string, VatDetailRow & { ids: Set<string> }>();
  const warnings: string[] = [];

  const addDetail = (direction: "output" | "input", code: string, field: string, base: number, tax: number, journalId: string) => {
    const key = `${direction}|${code}|${field}`;
    const row = detail.get(key) ?? { direction, taxCode: code, field, baseMinor: 0, taxMinor: 0, journals: 0, ids: new Set<string>() };
    row.baseMinor += base;
    row.taxMinor += tax;
    row.ids.add(journalId);
    row.journals = row.ids.size;
    detail.set(key, row);
  };

  for (const [journalId, jl] of byJournal) {
    const groups = new Map<string, Group>();
    const group = (direction: "output" | "input", code: string) => {
      const key = `${direction}|${code}`;
      let g = groups.get(key);
      if (!g) {
        g = { direction, code, tax: 0, vatBase: null, lineBase: 0, hasLineBase: false };
        groups.set(key, g);
      }
      return g;
    };
    const sourceKind = jl[0]?.sourceKind ?? null;
    const creditNote = isCreditNoteKind(sourceKind);
    const badDebt = jl.some((l) => l.isBadDebtAccount);
    for (const line of jl) {
      const vat = isVatAccount(line.accountSubtype);
      if (vat) {
        const code = line.taxCode ?? "za_std_15";
        const tax = vat === "output" ? line.creditMinor - line.debitMinor : line.debitMinor - line.creditMinor;
        const g = group(vat, code);
        g.tax += tax;
        if (line.taxBaseMinor != null && tax !== 0) g.vatBase = (g.vatBase ?? 0) + Math.sign(tax) * Math.abs(line.taxBaseMinor);
        continue;
      }
      if (!line.taxCode) continue;
      const counts = line.accountType === "income" || line.accountType === "expense" || line.accountSubtype === "fixed_asset";
      if (!counts) continue;
      const direction = line.accountType === "income" ? "output" : "input";
      const net = direction === "output" ? line.creditMinor - line.debitMinor : line.debitMinor - line.creditMinor;
      const base = line.taxBaseMinor != null && net !== 0 ? Math.sign(net) * Math.abs(line.taxBaseMinor) : net;
      const g = group(direction, line.taxCode);
      g.lineBase += base;
      g.hasLineBase = true;
    }
    const number = jl[0]?.journalNumber ?? journalId;
    for (const g of groups.values()) {
      let base = g.vatBase ?? (g.hasLineBase ? g.lineBase : null);
      if (base == null) {
        const rate = rateBpsFor(g.code);
        base = rate > 0 ? Math.round((g.tax * 10_000) / rate) : 0;
        if (g.tax !== 0) warnings.push(`${number}: no tax base on the VAT line; estimated from the rate`);
      }
      const tax = g.tax;
      if (g.direction === "output") {
        if (creditNote && tax !== 0) {
          boxes.f18 += -tax;
          addDetail("output", g.code, "18", base, tax, journalId);
          continue;
        }
        if (badDebt && tax !== 0) {
          boxes.f17 += -tax;
          addDetail("output", g.code, "17", base, tax, journalId);
          continue;
        }
        switch (g.code) {
          case "za_std_15":
            boxes.f1 += base + tax;
            boxes.f4 += tax;
            addDetail("output", g.code, "1/4", base, tax, journalId);
            break;
          case "za_capital_15":
            boxes.f1A += base + tax;
            boxes.f4A += tax;
            addDetail("output", g.code, "1A/4A", base, tax, journalId);
            break;
          case "za_zero":
            boxes.f2 += base;
            addDetail("output", g.code, "2", base, tax, journalId);
            break;
          case "za_export_zero":
            boxes.f2A += base;
            addDetail("output", g.code, "2A", base, tax, journalId);
            break;
          case "za_exempt":
            boxes.f3 += base;
            addDetail("output", g.code, "3", base, tax, journalId);
            break;
          default:
            addDetail("output", g.code, "—", base, tax, journalId);
        }
        if ((g.code === "za_zero" || g.code === "za_export_zero" || g.code === "za_exempt" || g.code === "za_out_of_scope") && tax !== 0) {
          warnings.push(`${number}: VAT posted on a ${g.code} supply`);
        }
      } else {
        if (creditNote && tax !== 0) {
          boxes.f12 += -tax;
          addDetail("input", g.code, "12", base, tax, journalId);
          continue;
        }
        switch (g.code) {
          case "za_std_15":
            boxes.f15 += tax;
            addDetail("input", g.code, "15", base, tax, journalId);
            break;
          case "za_capital_15":
            boxes.f14 += tax;
            addDetail("input", g.code, "14", base, tax, journalId);
            break;
          default:
            addDetail("input", g.code, "—", base, tax, journalId);
            if (tax !== 0) warnings.push(`${number}: input VAT on a ${g.code} purchase is not claimable`);
        }
      }
    }
  }

  for (const field of MANUAL_VAT_FIELDS) {
    const v = manual[field];
    if (typeof v === "number" && Number.isSafeInteger(v)) boxes[field] += v;
  }
  boxes.f11 = Math.round((boxes.f10 * 15) / 115);
  boxes.f8 = boxes.f6 + boxes.f7;
  boxes.f13 = boxes.f4 + boxes.f4A + boxes.f9 + boxes.f11 + boxes.f12;
  boxes.f19 = boxes.f14 + boxes.f14A + boxes.f15 + boxes.f15A + boxes.f16 + boxes.f17 + boxes.f18;
  boxes.f20 = boxes.f13 - boxes.f19;

  // SARS computes field 4 as field 1 × 15/115; ours comes from posted VAT, so
  // flag a gap larger than a cent per journal (rounding).
  const expected4 = Math.round((boxes.f1 * 15) / 115);
  const tolerance = Math.max(1, byJournal.size);
  if (Math.abs(expected4 - boxes.f4) > tolerance) {
    warnings.push(`Field 4 (${boxes.f4}) differs from field 1 × 15/115 (${expected4}) by more than rounding; check lines without a tax base.`);
  }

  return {
    boxes,
    detail: [...detail.values()].map(({ ids: _ids, ...row }) => row).sort((a, b) => a.direction.localeCompare(b.direction) || a.field.localeCompare(b.field)),
    warnings: [...new Set(warnings)].slice(0, 50),
  };
}
