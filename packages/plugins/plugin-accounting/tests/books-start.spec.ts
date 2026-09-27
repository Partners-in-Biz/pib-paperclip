import { describe, expect, it } from "vitest";
import { dayLabel, monthYearLabel, periodLabel, readableDates } from "../src/domain/dates.js";
import { cleanMemo } from "../src/domain/memo.js";
import { booksStart, endsBeforeBooks, vatPeriodsBetween, vatPeriodsInBooks } from "../src/domain/periods.js";
import { computeVatReturn, vatCodeName, type VatSourceLine } from "../src/domain/vat.js";

describe("when the books start", () => {
  it("is the day after the cut-over date, else the first journal, else the day the book was set up", () => {
    expect(booksStart({ cutoverDate: "2026-08-31", firstJournalDate: "2026-07-15", seededAt: "2026-09-26T10:00:00.000Z" })).toEqual({ date: "2026-09-01", from: "cutover" });
    expect(booksStart({ cutoverDate: "2026-12-31" })).toEqual({ date: "2027-01-01", from: "cutover" });
    expect(booksStart({ cutoverDate: null, firstJournalDate: "2026-09-26", seededAt: "2026-09-20T08:00:00.000Z" })).toEqual({ date: "2026-09-26", from: "first_journal" });
    expect(booksStart({ cutoverDate: null, firstJournalDate: null, seededAt: "2026-09-26T23:30:00.000Z" })).toEqual({ date: "2026-09-26", from: "set_up" });
    // Postgres writes timestamptz in the server's zone; the set-up day is its UTC day, like todayIso().
    expect(booksStart({ seededAt: "2026-09-28 00:30:00.123+02" })).toEqual({ date: "2026-09-27", from: "set_up" });
    expect(booksStart({})).toBeNull();
    expect(booksStart({ cutoverDate: "", firstJournalDate: "not a date", seededAt: null })).toBeNull();
  });

  it("leaves out VAT periods that ended before the books start, unless a return is already saved for one", () => {
    // Category B up to 27 Sep 2026: Jul–Aug 2025 … Sep–Oct 2026 (8 periods, as the VAT tab shows them).
    const periods = vatPeriodsBetween("2025-07-01", "2026-09-27", "B", 2);
    expect(periods).toHaveLength(8);
    expect(periods[0]).toEqual({ start: "2025-07-01", end: "2025-08-31" });
    // Books from 26 Sep 2026: only Sep–Oct 2026 is theirs.
    expect(vatPeriodsInBooks(periods, "2026-09-26")).toEqual([{ start: "2026-09-01", end: "2026-10-31" }]);
    // A period ending on the first day still counts; one with a saved return is kept.
    expect(vatPeriodsInBooks(periods, "2026-08-31").map((p) => p.end)).toEqual(["2026-08-31", "2026-10-31"]);
    expect(vatPeriodsInBooks(periods, "2026-09-26", (p) => p.start === "2026-03-01").map((p) => p.start)).toEqual(["2026-03-01", "2026-09-01"]);
    // Unknown start: everything.
    expect(vatPeriodsInBooks(periods, null)).toHaveLength(8);
    expect(endsBeforeBooks({ start: "2026-07-01", end: "2026-08-31" }, "2026-09-01")).toBe(true);
    expect(endsBeforeBooks({ start: "2026-09-01", end: "2026-10-31" }, "2026-09-26")).toBe(false);
    expect(endsBeforeBooks({ start: "2026-07-01", end: "2026-08-31" }, null)).toBe(false);
  });
});

describe("dates for people", () => {
  it("writes days, months and VAT periods the way the UI kit does", () => {
    expect(dayLabel("2026-09-28")).toBe("28 Sep 2026");
    expect(dayLabel("2026-09-26T10:22:33.000Z")).toBe("26 Sep 2026");
    expect(dayLabel("")).toBe("");
    expect(dayLabel("2026-13-01")).toBe("");
    expect(monthYearLabel("2026-02")).toBe("Feb 2026");
    expect(periodLabel("2026-09-01", "2026-10-31")).toBe("Sep–Oct 2026");
    expect(periodLabel("2026-09-01", "2026-09-30")).toBe("Sep 2026");
    expect(periodLabel("2025-12-01", "2026-01-31")).toBe("Dec 2025–Jan 2026");
    expect(periodLabel("2026-03-01", "2027-02-28")).toBe("Mar 2026–Feb 2027");
    expect(periodLabel("2026-09-01", "2026-10-15")).toBe("1 Sep 2026 to 15 Oct 2026");
  });

  it("makes dates inside server sentences readable, but leaves ids and file names alone", () => {
    expect(readableDates("The VAT period 2026-07-01 to 2026-08-31 is locked (return approved).")).toBe("The VAT period 1 Jul 2026 to 31 Aug 2026 is locked (return approved).");
    expect(readableDates("The period 2026-01 is closed. Reopen it under Accounting → Journals → Periods.")).toBe("The period Jan 2026 is closed. Reopen it under Accounting → Journals → Periods.");
    expect(readableDates("VAT Act s7(1)(a): 15% from 2018-04-01")).toBe("VAT Act s7(1)(a): 15% from 1 Apr 2018");
    expect(readableDates("vat201-2026-09-01-2026-10-31.csv")).toBe("vat201-2026-09-01-2026-10-31.csv");
    expect(readableDates("JNL-000012 on 2026-09-28T08:00:00Z")).toBe("JNL-000012 on 28 Sep 2026");
    expect(readableDates(null)).toBe("");
  });
});

describe("journal memos for people", () => {
  it("drops database ids that senders appended and tidies what is left", () => {
    expect(cleanMemo("Payment for NOR-002 (Payment ref NOR-002 thanks) bank tx 9a37a56a-073d-4804-acd3-2bc06e218a05")).toBe("Payment for NOR-002 (Payment ref NOR-002 thanks)");
    expect(cleanMemo("Refund (9a37a56a-073d-4804-acd3-2bc06e218a05)")).toBe("Refund");
    expect(cleanMemo("Bank TX: 9A37A56A-073D-4804-ACD3-2BC06E218A05 · Transfer to savings")).toBe("Transfer to savings");
    expect(cleanMemo("Fee, 9a37a56a-073d-4804-acd3-2bc06e218a05, monthly")).toBe("Fee, monthly");
    expect(cleanMemo("Deadline 9a37a56a-073d-4804-acd3-2bc06e218a05")).toBe("Deadline");
    expect(cleanMemo("9a37a56a-073d-4804-acd3-2bc06e218a05")).toBe("");
    expect(cleanMemo("Invoice INV-0042 for Acme (ref NOR-002)")).toBe("Invoice INV-0042 for Acme (ref NOR-002)");
    expect(cleanMemo(null)).toBe("");
    expect(cleanMemo("   ")).toBe("");
  });
});

describe("VAT201 warnings in plain words", () => {
  const line = (over: Partial<VatSourceLine>): VatSourceLine => ({ journalId: "j1", journalNumber: "JNL-000001", sourceKind: "invoice", accountType: "income", accountSubtype: "revenue", isBadDebtAccount: false, debitMinor: 0, creditMinor: 0, taxCode: null, taxBaseMinor: null, ...over });

  it("names VAT codes in words, never the code", () => {
    expect(vatCodeName("za_out_of_scope")).toBe("out-of-scope");
    expect(vatCodeName("za_export_zero")).toBe("zero-rated export");
    expect(vatCodeName("nope")).toBe("untaxed");
    const { warnings } = computeVatReturn([
      line({ creditMinor: 1_000_00, taxCode: "za_zero" }),
      line({ accountType: "liability", accountSubtype: "vat_output", creditMinor: 150_00, taxCode: "za_zero", taxBaseMinor: 1_000_00 }),
      line({ journalId: "j2", journalNumber: "JNL-000002", sourceKind: "bill", accountType: "asset", accountSubtype: "vat_input", debitMinor: 15_00, taxCode: "za_out_of_scope" }),
    ]);
    expect(warnings).toContain("JNL-000001: VAT was charged on a sale coded zero-rated");
    expect(warnings).toContain("JNL-000002: VAT paid on a purchase coded out-of-scope cannot be claimed");
    expect(warnings.join(" ")).not.toMatch(/za_/);
  });

  it("writes the field 4 check in rand", () => {
    const { warnings } = computeVatReturn([
      line({ creditMinor: 1_000_00, taxCode: "za_std_15" }),
      line({ accountType: "liability", accountSubtype: "vat_output", creditMinor: 100_00, taxCode: "za_std_15", taxBaseMinor: 1_000_00 }),
    ]);
    expect(warnings.find((w) => w.startsWith("Field 4"))).toBe("Field 4 (R 100.00) differs from field 1 × 15/115 (R 143.48) by more than rounding; check VAT lines without an amount before VAT.");
  });
});
