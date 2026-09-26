import { describe, expect, it } from "vitest";
import { isBalanced } from "@partnersinbiz/pib-plugin-kit";
import { allocate, computeDocument, computeLine, legacyTaxCode, parseMoneyToMinor, roundDiv, splitByGroups } from "../src/money.js";
import { balanceOutstanding, daysPastDue, deriveInvoiceStatus, type BalanceState } from "../src/domain.js";
import { basePrefix, formatDocNumber, prefixCandidates, sequenceOf } from "../src/numbering.js";
import { hoursLabel, minutesBetween, timeAmountMinor, timeLineDescription } from "../src/time.js";

describe("per-line VAT", () => {
  it("adds VAT per line on exclusive prices", () => {
    expect(computeLine({ quantity: 2, unitAmountMinor: 10_001, taxCode: "za_std_15" }, {})).toEqual({ netMinor: 20_002, vatMinor: 3_000, grossMinor: 23_002, rateBp: 1500, taxCode: "za_std_15" });
    expect(computeLine({ quantity: 1, unitAmountMinor: 5_000, taxCode: "za_exempt" }, {})).toMatchObject({ vatMinor: 0, grossMinor: 5_000 });
  });

  it("extracts VAT from inclusive prices", () => {
    expect(computeLine({ quantity: 1, unitAmountMinor: 115_000, taxCode: "za_std_15" }, { pricesIncludeVat: true })).toMatchObject({ netMinor: 100_000, vatMinor: 15_000, grossMinor: 115_000 });
    expect(computeLine({ quantity: 1, unitAmountMinor: 100, taxCode: "za_std_15" }, { pricesIncludeVat: true })).toMatchObject({ netMinor: 87, vatMinor: 13 });
  });

  it("groups totals by VAT code", () => {
    const totals = computeDocument(
      [
        { quantity: 1, unitAmountMinor: 100_000, taxCode: "za_std_15" },
        { quantity: 3, unitAmountMinor: 3_333, taxCode: "za_std_15" },
        { quantity: 1, unitAmountMinor: 20_000, taxCode: "za_zero" },
      ],
      {},
    );
    expect(totals.legacy).toBe(false);
    expect(totals.subtotalMinor).toBe(129_999);
    expect(totals.vatMinor).toBe(15_000 + 1_500);
    expect(totals.totalMinor).toBe(totals.subtotalMinor + totals.vatMinor);
    expect(totals.groups).toEqual([
      { taxCode: "za_std_15", rateBp: 1500, netMinor: 109_999, vatMinor: 16_500, grossMinor: 126_499 },
      { taxCode: "za_zero", rateBp: 0, netMinor: 20_000, vatMinor: 0, grossMinor: 20_000 },
    ]);
  });

  it("keeps 0.2 totals when no line has a code (rate on the subtotal, rounded once)", () => {
    const totals = computeDocument([{ quantity: 1, unitAmountMinor: 1_000_000 }, { quantity: 2, unitAmountMinor: 250_050 }], { taxRatePercent: 15 });
    expect(totals.legacy).toBe(true);
    expect(totals).toMatchObject({ subtotalMinor: 1_500_100, vatMinor: 225_015, totalMinor: 1_725_115 });
    expect(totals.lines.reduce((a, l) => a + l.vatMinor, 0)).toBe(225_015);
    expect(totals.groups[0]!.taxCode).toBe("za_std_15");
    expect(legacyTaxCode(0)).toBeNull();
  });

  it("uses the document rate for uncoded lines next to coded ones", () => {
    const totals = computeDocument([{ quantity: 1, unitAmountMinor: 1_000 }, { quantity: 1, unitAmountMinor: 1_000, taxCode: "za_zero" }], { taxRatePercent: 15 });
    expect(totals.vatMinor).toBe(150);
  });

  it("rejects bad quantities and amounts", () => {
    expect(() => computeDocument([{ quantity: 0, unitAmountMinor: 1 }], {})).toThrow(/positive integer/);
    expect(() => computeDocument([{ quantity: 1, unitAmountMinor: 1.5 }], {})).toThrow(/minor units/);
  });

  it("splits amounts exactly and reverses VAT at the charged rate", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(10, [0, 0])).toEqual([10, 0]);
    const split = splitByGroups(11_500, [
      { taxCode: "za_std_15", rateBp: 1500, netMinor: 100_000, vatMinor: 15_000, grossMinor: 115_000 },
      { taxCode: "za_zero", rateBp: 0, netMinor: 20_000, vatMinor: 0, grossMinor: 20_000 },
    ]);
    expect(split.reduce((a, g) => a + g.grossMinor, 0)).toBe(11_500);
    expect(split[0]).toMatchObject({ grossMinor: 9_796, vatMinor: 1_278, netMinor: 8_518 });
    expect(split[1]).toMatchObject({ grossMinor: 1_704, vatMinor: 0 });
    expect(roundDiv(5, 2)).toBe(3);
    expect(parseMoneyToMinor("R 1 234,50")).toBe(123_450);
    expect(parseMoneyToMinor("1,234.50")).toBe(123_450);
  });
});

describe("numbering", () => {
  it("takes the first three letters, padded", () => {
    expect(basePrefix("Lumen Digital")).toBe("LUM");
    expect(basePrefix("Jo")).toBe("JOX");
    expect(basePrefix("Élan Café")).toBe("ELA");
    expect(basePrefix("123")).toBe("XXX");
  });

  it("offers deterministic alternatives when a prefix is taken, never the legacy ones", () => {
    expect(prefixCandidates("Lumos Labs").slice(0, 4)).toEqual(["LUM", "LUO", "LUS", "LUL"]);
    expect(prefixCandidates("Invest Co")).not.toContain("INV");
    expect(new Set(prefixCandidates("Ab")).size).toBe(prefixCandidates("Ab").length);
  });

  it("formats and parses document numbers per kind", () => {
    expect(formatDocNumber("invoice", "LUM", 1)).toBe("LUM-001");
    expect(formatDocNumber("quote", "LUM", 12)).toBe("Q-LUM-012");
    expect(formatDocNumber("credit_note", "LUM", 3)).toBe("CN-LUM-003");
    expect(formatDocNumber("invoice", "LUM", 1234)).toBe("LUM-1234");
    expect(sequenceOf("LUM-007", "invoice", "LUM")).toBe(7);
    expect(sequenceOf("Q-LUM-007", "invoice", "LUM")).toBe(0);
    expect(sequenceOf("Q-LUM-007", "quote", "LUM")).toBe(7);
  });
});

describe("invoice status from money", () => {
  const base: BalanceState = { status: "sent", totalMinor: 10_000, paidMinor: 0, creditedMinor: 0, writtenOffMinor: 0, pendingPops: 0, paymentCount: 0, dueAt: "2026-10-01T00:00:00Z" };
  const now = new Date("2026-09-26T00:00:00Z");

  it("moves through partly paid, pending verification, paid and written off", () => {
    expect(deriveInvoiceStatus(base, now)).toBe("sent");
    expect(deriveInvoiceStatus({ ...base, pendingPops: 1 }, now)).toBe("payment_pending_verification");
    expect(deriveInvoiceStatus({ ...base, paidMinor: 4_000, paymentCount: 1 }, now)).toBe("partially_paid");
    expect(deriveInvoiceStatus({ ...base, paidMinor: 6_000, creditedMinor: 4_000, paymentCount: 1 }, now)).toBe("paid");
    expect(deriveInvoiceStatus({ ...base, paidMinor: 6_000, writtenOffMinor: 4_000, paymentCount: 1 }, now)).toBe("written_off");
    expect(deriveInvoiceStatus({ ...base, dueAt: "2026-09-01T00:00:00Z" }, now)).toBe("overdue");
    expect(deriveInvoiceStatus({ ...base, status: "draft", paidMinor: 10_000 }, now)).toBe("draft");
  });

  it("keeps invoices paid before payments were recorded (0.2 approvals)", () => {
    expect(deriveInvoiceStatus({ ...base, status: "paid" }, now)).toBe("paid");
    expect(balanceOutstanding({ ...base, status: "paid" })).toBe(0);
    expect(balanceOutstanding({ ...base, status: "partially_paid", paidMinor: 2_500 })).toBe(7_500);
    expect(daysPastDue("2026-09-16T00:00:00Z", now)).toBe(10);
    expect(daysPastDue(null, now)).toBe(0);
  });
});

describe("time", () => {
  it("charges hours × rate in cents", () => {
    expect(minutesBetween("2026-09-26T08:00:00Z", "2026-09-26T09:30:20Z")).toBe(90);
    expect(minutesBetween("2026-09-26T08:00:00Z", "2026-09-26T08:00:10Z")).toBe(1);
    expect(timeAmountMinor(90, 85_000)).toBe(127_500);
    expect(timeAmountMinor(10, 100)).toBe(17);
    expect(hoursLabel(90)).toBe("1.5 h");
    expect(timeLineDescription({ description: "Call", minutes: 60, rateMinor: 85_000, currency: "ZAR", startedAt: "2026-09-26T08:00:00Z" })).toBe("Call (2026-09-26): 1 h @ R 850.00/h");
  });

  it("is balanced when it should be (kit check sanity)", () => {
    expect(isBalanced([{ role: "ar", debitMinor: 1, creditMinor: 0 }, { role: "revenue", debitMinor: 0, creditMinor: 1 }])).toBe(true);
  });
});
