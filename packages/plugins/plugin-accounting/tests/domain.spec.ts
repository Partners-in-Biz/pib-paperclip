import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { ACCOUNT_ROLES, TAX_CODES } from "@partnersinbiz/pib-plugin-kit";
import {
  chartSeedRows,
  normaliseRole,
  resolveRoleCode,
  roleSeedRows,
  typeOfSubtype,
  validateAccountInput,
  ZA_CATEGORY_ROLES,
  ZA_CHART,
  ZA_ROLE_MAP,
  type Account,
} from "../src/domain/chart.js";
import {
  convertToBook,
  GENESIS_HASH,
  journalHash,
  journalNumber,
  resolveLines,
  reverseLines,
  validatePostingInput,
  verifyChain,
  type JournalContent,
  type JournalLine,
} from "../src/domain/journal.js";
import { financialYear, parseVatCategory, previousRange, sameRangeLastYear, vatPeriodFor, vatPeriodsBetween } from "../src/domain/periods.js";
import { fingerprintLines, normalizeDate, parseAmount, parseStatement } from "../src/domain/statements.js";
import { firstMatchingRule, matchJournals, matchOpenItems, splitVat, suggestFor, validateRule, type BankRule, type OpenItemLike } from "../src/domain/matching.js";
import { reconciliationSummary } from "../src/domain/reconcile.js";
import { computeVatReturn, type VatSourceLine } from "../src/domain/vat.js";
import { agedReport, balanceSheet, budgetVsActual, cashFlow, cashForecast, compareProfitAndLoss, generalLedger, profitAndLoss, trialBalance, type AccountTotals } from "../src/domain/reports.js";
import { accumulatedThrough, depreciationSchedule, disposalLines, dueDepreciation } from "../src/domain/assets.js";
import { invertRates, revalue } from "../src/domain/fx.js";
import { openingJournalLines, parseOpeningTb } from "../src/domain/cutover.js";
import { crc32, csvCell, toCsv, zipFiles } from "../src/domain/files.js";
import { AccountingError, addMonths, canonicalJson, lastDayOfMonth } from "../src/domain/util.js";
import { categoryLines } from "../src/service/bank.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** The template chart as Account rows (ids = "a-<code>"). */
function templateChart(): Account[] {
  return ZA_CHART.map((a) => ({
    id: `a-${a.code}`,
    code: a.code,
    name: a.name,
    type: typeOfSubtype(a.subtype),
    subtype: a.subtype,
    cashFlow: chartSeedRows(() => "x").find((r) => r.code === a.code)!.cash_flow as Account["cashFlow"],
    description: "",
    system: Boolean(a.system),
    active: true,
  }));
}

function chartIndex(accounts = templateChart()) {
  return {
    byCode: new Map(accounts.map((a) => [a.code, a])),
    roles: new Map(roleSeedRows().map((r) => [r.role, r.account_code])),
  };
}

// ---------------------------------------------------------------------------

describe("chart of accounts template", () => {
  it("maps every kit account role to an account that exists", () => {
    const codes = new Set(ZA_CHART.map((a) => a.code));
    for (const role of ACCOUNT_ROLES) {
      expect(ZA_ROLE_MAP[role], role).toBeTruthy();
      expect(codes.has(ZA_ROLE_MAP[role]), `${role} → ${ZA_ROLE_MAP[role]}`).toBe(true);
    }
    for (const [role, code] of Object.entries(ZA_CATEGORY_ROLES)) expect(codes.has(code), role).toBe(true);
  });

  it("has unique codes, system accounts behind every role, and the SA essentials", () => {
    const codes = ZA_CHART.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    const byCode = new Map(ZA_CHART.map((a) => [a.code, a]));
    for (const code of Object.values(ZA_ROLE_MAP)) expect(byCode.get(code)!.system, code).toBe(true);
    const subtypes = new Set(ZA_CHART.map((a) => a.subtype));
    for (const s of ["bank", "receivable", "payable", "vat_input", "vat_output", "vat_control", "payroll_liability", "fixed_asset", "accumulated_depreciation", "retained_earnings", "opening_balance_equity", "suspense", "depreciation"]) {
      expect(subtypes.has(s as never), s).toBe(true);
    }
  });

  it("resolves roles with the category fallback", () => {
    const roles = chartIndex().roles;
    expect(resolveRoleCode("ar", roles)).toBe("1100");
    expect(resolveRoleCode("expense:software", roles)).toBe("6130");
    expect(resolveRoleCode("expense:Software & SaaS", roles)).toBe("6500");
    expect(normaliseRole("expense:Software & SaaS")).toBe("expense:software_saas");
    expect(resolveRoleCode("expense:unknown_thing", roles)).toBe("6500");
    expect(resolveRoleCode("revenue:consulting", roles)).toBe("4000");
    expect(resolveRoleCode("revenue:employment_tax_incentive", roles)).toBe("4300");
    expect(resolveRoleCode("nonsense", roles)).toBeNull();
  });

  it("validates new accounts", () => {
    expect(validateAccountInput({ code: "6600", name: "Cleaning", subtype: "expense" })).toMatchObject({ type: "expense", cashFlow: "operating" });
    expect(validateAccountInput({ code: "1030", name: "Savings", subtype: "bank" }).cashFlow).toBe("cash");
    expect(() => validateAccountInput({ code: "", name: "x", subtype: "expense" })).toThrow();
    expect(() => validateAccountInput({ code: "1", name: "x", subtype: "weird" })).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("journals", () => {
  const invoice = [
    { role: "ar" as const, debitMinor: 115_00, creditMinor: 0, clientKind: "company" as const, clientRef: "c1" },
    { role: "revenue" as const, debitMinor: 0, creditMinor: 100_00, taxCode: "za_std_15" as const },
    { role: "vat_output" as const, debitMinor: 0, creditMinor: 15_00, taxCode: "za_std_15" as const, taxBaseMinor: 100_00 },
  ];

  it("validates balance and shape", () => {
    expect(() => validatePostingInput({ date: "2026-09-01", lines: invoice })).not.toThrow();
    expect(() => validatePostingInput({ date: "2026-02-30", lines: invoice })).toThrow(/date/);
    const unbalanced = [invoice[0]!, { ...invoice[1]!, creditMinor: 99_00 }];
    try {
      validatePostingInput({ date: "2026-09-01", lines: unbalanced });
      expect.unreachable();
    } catch (error) {
      expect((error as AccountingError).code).toBe("unbalanced");
    }
    expect(() => validatePostingInput({ date: "2026-09-01", lines: [{ role: "ar", debitMinor: 1.5, creditMinor: 0 }, { role: "revenue", debitMinor: 0, creditMinor: 1.5 }] })).toThrow();
    expect(() => validatePostingInput({ date: "2026-09-01", lines: [{ role: "ar", debitMinor: 5, creditMinor: 5 }, { role: "revenue", debitMinor: 0, creditMinor: 0 }] })).toThrow(/both/);
    expect(() => validatePostingInput({ date: "2026-09-01", lines: [{ role: "ar", debitMinor: 5, creditMinor: 0, taxCode: "za_bogus" as never }, { role: "revenue", debitMinor: 0, creditMinor: 5 }] })).toThrow(/tax code/);
  });

  it("maps roles to accounts and rejects unknown roles with a clear message", () => {
    const lines = resolveLines(invoice, chartIndex());
    expect(lines.map((l) => l.accountCode)).toEqual(["1100", "4000", "2100"]);
    expect(lines[0]!.clientRef).toBe("c1");
    const roles = new Map(chartIndex().roles);
    roles.delete("vat_output");
    try {
      resolveLines(invoice, { byCode: chartIndex().byCode, roles });
      expect.unreachable();
    } catch (error) {
      expect((error as AccountingError).code).toBe("unknown_role");
      expect((error as Error).message).toMatch(/vat_output/);
    }
    expect(() => resolveLines([{ accountCode: "9999", debitMinor: 1, creditMinor: 0 }, { role: "ar", debitMinor: 0, creditMinor: 1 }], chartIndex())).toThrow(/Unknown account 9999/);
  });

  it("converts foreign lines to ZAR and books rounding", () => {
    const resolved = resolveLines(
      [
        { role: "ar", debitMinor: 1_001, creditMinor: 0 },
        { role: "revenue", debitMinor: 0, creditMinor: 500 },
        { role: "revenue", debitMinor: 0, creditMinor: 501 },
      ],
      chartIndex(),
    );
    const { lines, fxRate } = convertToBook(resolved, { currency: "USD", bookCurrency: "ZAR", fxRate: 18.333, rounding: { accountId: "a-6410", accountCode: "6410" } });
    expect(fxRate).toBe(18.333);
    const d = lines.reduce((s, l) => s + l.debitMinor, 0);
    const c = lines.reduce((s, l) => s + l.creditMinor, 0);
    expect(d).toBe(c);
    expect(lines[0]!.originalDebitMinor).toBe(1_001);
    expect(() => convertToBook(resolved, { currency: "USD", bookCurrency: "ZAR" })).toThrow(/fxRate/);
  });

  function content(seq: number, prevHash: string, lines: JournalLine[]): JournalContent {
    return {
      companyId: "co",
      seq,
      number: journalNumber(seq),
      date: "2026-09-01",
      memo: `J${seq}`,
      kind: "event",
      currency: "ZAR",
      fxRate: null,
      bookCurrency: "ZAR",
      sourceKey: `k${seq}`,
      source: { plugin: "partnersinbiz.billing", kind: "invoice", id: `i${seq}` },
      lines,
      reversesId: null,
      prevHash,
    };
  }

  it("numbers journals and chains their hashes; any edit breaks the chain", () => {
    expect(journalNumber(123)).toBe("JNL-000123");
    const lines = resolveLines(invoice, chartIndex());
    const j1 = content(1, GENESIS_HASH, lines);
    const h1 = journalHash(j1);
    const j2 = content(2, h1, reverseLines(lines));
    const h2 = journalHash(j2);
    const chain = [{ ...j1, hash: h1 }, { ...j2, hash: h2 }];
    expect(verifyChain(chain)).toMatchObject({ ok: true, checked: 2, lastHash: h2 });
    // Key order and null members do not change the hash (jsonb round-trip).
    const shuffled = { ...j1, lines: j1.lines.map((l) => Object.fromEntries(Object.entries(l).reverse()) as JournalLine) };
    expect(journalHash(shuffled)).toBe(h1);
    const tampered = [{ ...j1, hash: h1, memo: "changed" }, { ...j2, hash: h2 }];
    expect(verifyChain(tampered)).toMatchObject({ ok: false, firstBadSeq: 1 });
    const gap = [{ ...j1, hash: h1 }, { ...content(3, h1, lines), hash: journalHash(content(3, h1, lines)) }];
    expect(verifyChain(gap).problem).toMatch(/missing/);
    const amount = [{ ...j1, hash: h1, lines: j1.lines.map((l, i) => (i === 0 ? { ...l, debitMinor: 116_00 } : l)) }];
    expect(verifyChain(amount).ok).toBe(false);
  });

  it("reversal swaps debit and credit and keeps tax data", () => {
    const lines = resolveLines(invoice, chartIndex());
    const rev = reverseLines(lines);
    expect(rev[0]).toMatchObject({ accountCode: "1100", debitMinor: 0, creditMinor: 115_00 });
    expect(rev[2]).toMatchObject({ accountCode: "2100", debitMinor: 15_00, creditMinor: 0, taxCode: "za_std_15", taxBaseMinor: 100_00 });
  });

  it("canonical JSON is key-order independent and skips nulls", () => {
    expect(canonicalJson({ b: 1, a: null, c: { y: 2, x: undefined, w: [1, { z: null, q: 1 }] } })).toBe('{"b":1,"c":{"w":[1,{"q":1}],"y":2}}');
  });
});

// ---------------------------------------------------------------------------

describe("periods", () => {
  it("financial year from the year-end month", () => {
    expect(financialYear("2026-09-26", 2)).toEqual({ start: "2026-03-01", end: "2027-02-28" });
    expect(financialYear("2026-02-10", 2)).toEqual({ start: "2025-03-01", end: "2026-02-28" });
    expect(financialYear("2026-06-30", 12)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
  });

  it("SARS VAT categories", () => {
    expect(vatPeriodFor("2026-09-26", "A")).toEqual({ start: "2026-08-01", end: "2026-09-30" });
    expect(vatPeriodFor("2026-09-26", "B")).toEqual({ start: "2026-09-01", end: "2026-10-31" });
    expect(vatPeriodFor("2026-01-15", "A")).toEqual({ start: "2025-12-01", end: "2026-01-31" });
    expect(vatPeriodFor("2026-09-26", "C")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(vatPeriodFor("2026-09-26", "D")).toEqual({ start: "2026-09-01", end: "2027-02-28" });
    expect(vatPeriodFor("2026-09-26", "E", 2)).toEqual({ start: "2026-03-01", end: "2027-02-28" });
    expect(vatPeriodFor("2026-09-26", "none")).toBeNull();
    expect(vatPeriodsBetween("2026-01-01", "2026-06-30", "B").map((p) => p.end)).toEqual(["2026-02-28", "2026-04-30", "2026-06-30"]);
    expect(parseVatCategory("monthly")).toBe("C");
    expect(() => parseVatCategory("Z")).toThrow();
  });

  it("comparison ranges", () => {
    expect(previousRange({ start: "2026-09-01", end: "2026-09-30" })).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(sameRangeLastYear({ start: "2026-03-01", end: "2026-04-30" })).toEqual({ start: "2025-03-01", end: "2025-04-30" });
    expect(lastDayOfMonth("2028-02")).toBe("2028-02-29");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
  });
});

// ---------------------------------------------------------------------------

describe("statement parsers", () => {
  it("CSV with title rows, signed amounts and a balance column", () => {
    const s = parseStatement(fixture("fnb.csv"));
    expect(s.format).toBe("csv");
    expect(s.lines).toHaveLength(5);
    expect(s.lines[0]).toMatchObject({ date: "2026-09-01", amountMinor: -150_00, description: "FNB Monthly account fee", reference: "FEE", balanceMinor: 9850_00 });
    expect(s.lines[1]!.amountMinor).toBe(11_500_00);
    expect(s.openingMinor).toBe(10_000_00);
    expect(s.closingMinor).toBe(20_100_00);
    expect(s.periodStart).toBe("2026-09-01");
    expect(s.periodEnd).toBe("2026-09-03");
  });

  it("CSV with semicolons, debit/credit columns, decimal commas and text dates", () => {
    const s = parseStatement(fixture("debit-credit.csv"));
    expect(s.lines.map((l) => l.amountMinor)).toEqual([-25_000_00, 12_34, -1_150_00]);
    expect(s.lines[2]).toMatchObject({ date: "2026-09-03", description: "Card purchase; Takealot" });
    expect(s.openingMinor).toBe(100_000_00);
    expect(s.closingMinor).toBe(73_862_34);
  });

  it("OFX with FITIDs and the ledger balance", () => {
    const s = parseStatement(fixture("statement.ofx"));
    expect(s.format).toBe("ofx");
    expect(s.lines).toEqual([
      expect.objectContaining({ date: "2026-09-05", amountMinor: -230_00, bankId: "T1001", counterparty: "ESKOM", description: "ESKOM — Prepaid electricity" }),
      expect.objectContaining({ date: "2026-09-06", amountMinor: 5_750_00, bankId: "T1002" }),
    ]);
    expect(s.closingMinor).toBe(15_520_00);
    expect(s.openingMinor).toBe(10_000_00);
    expect(s.periodStart).toBe("2026-09-01");
    expect(s.periodEnd).toBe("2026-09-30");
  });

  it("MT940 with :86: narratives and :60F:/:62F: balances", () => {
    const s = parseStatement(fixture("statement.mt940"));
    expect(s.format).toBe("mt940");
    expect(s.lines).toEqual([
      expect.objectContaining({ date: "2026-09-01", amountMinor: -150_00, description: "MONTHLY FEE", reference: null }),
      expect.objectContaining({ date: "2026-09-02", amountMinor: 11_500_00, description: "ACME PTY LTD PAYMENT INV-1001", reference: "INV-1001" }),
    ]);
    expect(s.openingMinor).toBe(10_000_00);
    expect(s.closingMinor).toBe(21_350_00);
  });

  it("amount and date formats", () => {
    expect(parseAmount("R1 234,56")).toBe(123_456);
    expect(parseAmount("1,234.56")).toBe(123_456);
    expect(parseAmount("(12.00)")).toBe(-12_00);
    expect(parseAmount("12.00 Dr")).toBe(-12_00);
    expect(parseAmount("12.00CR")).toBe(12_00);
    expect(parseAmount("-0.5")).toBe(-50);
    expect(() => parseAmount("abc")).toThrow();
    expect(normalizeDate("2026/09/01")).toBe("2026-09-01");
    expect(normalizeDate("1/9/2026")).toBe("2026-09-01");
    expect(normalizeDate("20260901")).toBe("2026-09-01");
    expect(normalizeDate("01 September 2026")).toBe("2026-09-01");
  });

  it("fingerprints keep genuine duplicates and dedupe re-imports", () => {
    const s = parseStatement(fixture("fnb.csv"));
    const a = fingerprintLines("bank1", s.lines);
    expect(new Set(a).size).toBe(5); // two identical coffees stay two lines
    const again = fingerprintLines("bank1", parseStatement(fixture("fnb.csv")).lines);
    expect(again).toEqual(a);
    const overlap = fingerprintLines("bank1", s.lines.slice(1));
    expect(overlap.every((f) => a.includes(f))).toBe(true);
    expect(fingerprintLines("bank2", s.lines)[0]).not.toBe(a[0]);
  });
});

// ---------------------------------------------------------------------------

describe("bank rules and matching", () => {
  const line = { id: "l1", date: "2026-09-02", amountMinor: 11_500_00, description: "ACME PTY LTD INV-1001", reference: "INV-1001", counterparty: null };
  const items: OpenItemLike[] = [
    { key: "invoice:1", kind: "receivable", number: "INV-1001", counterpartyName: "Acme", currency: "ZAR", outstandingMinor: 11_500_00, refs: [], dueDate: "2026-09-10" },
    { key: "invoice:2", kind: "receivable", number: "INV-1005", counterpartyName: "Beta", currency: "ZAR", outstandingMinor: 11_500_00, refs: ["BETA01"], dueDate: "2026-09-30" },
    { key: "invoice:3", kind: "receivable", number: "INV-2000", counterpartyName: "Gamma", currency: "ZAR", outstandingMinor: 50_000_00, refs: [], dueDate: null },
    { key: "bill:1", kind: "payable", number: "BILL-7731", counterpartyName: "Supplier", currency: "ZAR", outstandingMinor: 11_500_00, refs: [], dueDate: null },
    { key: "invoice:usd", kind: "receivable", number: "INV-USD", counterpartyName: "US Co", currency: "USD", outstandingMinor: 11_500_00, refs: [], dueDate: null },
  ];

  it("exact when amount and number match, amount-only otherwise, never across kinds or currencies", () => {
    const s = matchOpenItems(line, items);
    expect(s[0]).toMatchObject({ kind: "open_item", key: "invoice:1", basis: "exact" });
    expect(s[1]).toMatchObject({ key: "invoice:2", basis: "amount" });
    expect(s.some((x) => x.kind === "open_item" && (x.key === "bill:1" || x.key === "invoice:usd"))).toBe(false);
  });

  it("reference match with a smaller amount is a part payment", () => {
    const part = { ...line, amountMinor: 20_000_00, description: "GAMMA INV-2000 part" };
    expect(matchOpenItems(part, items)[0]).toMatchObject({ key: "invoice:3", basis: "reference" });
    // Short tokens do not match by accident.
    expect(matchOpenItems({ ...line, amountMinor: 1_00, description: "12" }, [{ ...items[0]!, number: "12", outstandingMinor: 5_00 }])).toEqual([]);
  });

  it("money out matches payables", () => {
    expect(matchOpenItems({ ...line, amountMinor: -11_500_00, description: "PAY BILL 7731 supplier" }, items)[0]).toMatchObject({ key: "bill:1", basis: "exact" });
  });

  it("journals on the bank with the same amount within 10 days", () => {
    const s = matchJournals(line, [
      { journalId: "j1", number: "JNL-000001", date: "2026-09-01", memo: "Payment", amountMinor: 11_500_00 },
      { journalId: "j2", number: "JNL-000002", date: "2026-08-01", memo: "Old", amountMinor: 11_500_00 },
      { journalId: "j3", number: "JNL-000003", date: "2026-09-02", memo: "Other", amountMinor: 1_00 },
    ]);
    expect(s.map((x) => x.kind === "journal" && x.journalId)).toEqual(["j1"]);
  });

  it("rules by priority, direction and amount", () => {
    const rules: BankRule[] = [
      { id: "r1", ...validateRule({ name: "Fees", field: "description", operator: "contains", value: "account fee", accountCode: "6120", direction: "out", priority: 10 }) },
      { id: "r2", ...validateRule({ name: "Big", field: "amount", operator: "amount_between", amountMinMinor: 100_000_00, accountCode: "1990" }) },
      { id: "r3", ...validateRule({ name: "Google", field: "description", operator: "starts_with", value: "google", accountCode: "6130", taxCode: "za_std_15" }) },
    ];
    expect(firstMatchingRule(rules, { ...line, amountMinor: -150_00, description: "FNB Monthly ACCOUNT FEE" })?.id).toBe("r1");
    expect(firstMatchingRule(rules, { ...line, amountMinor: 150_00, description: "account fee refund" })).toBeNull();
    expect(firstMatchingRule(rules, { ...line, amountMinor: -200_000_00, description: "x" })?.id).toBe("r2");
    expect(firstMatchingRule(rules, { ...line, amountMinor: -1_150_00, description: "Google Workspace" })?.accountCode).toBe("6130");
    expect(() => validateRule({ name: "x", field: "amount", operator: "contains", value: "a", accountCode: "1" })).toThrow();
    const all = suggestFor({ ...line, amountMinor: -1_150_00, description: "GOOGLE WORKSPACE" }, { items, journals: [], rules });
    expect(all[0]).toMatchObject({ kind: "category", source: "rule", accountCode: "6130", taxCode: "za_std_15" });
  });

  it("VAT fraction split (15/115, half-up)", () => {
    expect(splitVat(1_150_00, 1500)).toEqual({ netMinor: 1_000_00, vatMinor: 150_00 });
    expect(splitVat(-100, 1500)).toEqual({ netMinor: 87, vatMinor: 13 });
    expect(splitVat(500, 0)).toEqual({ netMinor: 500, vatMinor: 0 });
  });

  it("category journal lines: bank vs account with VAT split", () => {
    const out = categoryLines({ amountMinor: -1_150_00, bankCode: "1000", accountCode: "6130", taxCode: "za_std_15", rateBps: 1500, memo: "Google", counterparty: null, lineId: "l1" });
    expect(out.map((l) => [l.accountCode ?? l.role, l.debitMinor, l.creditMinor])).toEqual([
      ["6130", 1_000_00, 0],
      ["vat_input", 150_00, 0],
      ["1000", 0, 1_150_00],
    ]);
    expect(out[1]!.taxBaseMinor).toBe(1_000_00);
    const inflow = categoryLines({ amountMinor: 5_750_00, bankCode: "1000", accountCode: "4000", taxCode: "za_std_15", rateBps: 1500, memo: "Sale", counterparty: null, lineId: "l2" });
    expect(inflow.map((l) => [l.accountCode ?? l.role, l.debitMinor, l.creditMinor])).toEqual([
      ["1000", 5_750_00, 0],
      ["vat_output", 0, 750_00],
      ["4000", 0, 5_000_00],
    ]);
    const plain = categoryLines({ amountMinor: -150_00, bankCode: "1000", accountCode: "6120", taxCode: null, rateBps: 0, memo: "Fee", counterparty: null, lineId: "l3" });
    expect(plain).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("reconciliation", () => {
  it("difference is zero only when opening + lines = closing", () => {
    const lines = [
      { amountMinor: -150_00, status: "reconciled" as const },
      { amountMinor: 11_500_00, status: "reconciled" as const },
      { amountMinor: -50_00, status: "excluded" as const },
    ];
    const ok = reconciliationSummary({ openingMinor: 10_000_00, closingMinor: 21_300_00, lines, glBalanceMinor: 21_350_00 });
    expect(ok).toMatchObject({ differenceMinor: 0, ready: true, glDifferenceMinor: -50_00 });
    const missing = reconciliationSummary({ openingMinor: 10_000_00, closingMinor: 21_350_00, lines, glBalanceMinor: 0 });
    expect(missing.differenceMinor).toBe(50_00);
    expect(missing.ready).toBe(false);
    const open = reconciliationSummary({ openingMinor: 0, closingMinor: 100, lines: [{ amountMinor: 100, status: "matching" }], glBalanceMinor: 0 });
    expect(open.unreconciledCount).toBe(1);
    expect(open.ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("VAT201", () => {
  const acc = (subtype: VatSourceLine["accountSubtype"], type: VatSourceLine["accountType"]) => ({ accountSubtype: subtype, accountType: type, isBadDebtAccount: false });
  const L = (journalId: string, kind: string | null, a: ReturnType<typeof acc>, debit: number, credit: number, taxCode: string | null = null, base: number | null = null): VatSourceLine => ({
    journalId,
    journalNumber: journalId,
    sourceKind: kind,
    ...a,
    debitMinor: debit,
    creditMinor: credit,
    taxCode,
    taxBaseMinor: base,
  });
  const AR = acc("receivable", "asset");
  const REV = acc("revenue", "income");
  const OUT = acc("vat_output", "liability");
  const IN = acc("vat_input", "asset");
  const EXP = acc("expense", "expense");
  const FA = acc("fixed_asset", "asset");
  const AP = acc("payable", "liability");

  const journals: VatSourceLine[] = [
    // Standard-rated invoice R1 000 + R150 VAT (base on the VAT line; the revenue line also carries the code)
    L("inv1", "invoice", AR, 1_150_00, 0),
    L("inv1", "invoice", REV, 0, 1_000_00, "za_std_15"),
    L("inv1", "invoice", OUT, 0, 150_00, "za_std_15", 1_000_00),
    // Zero-rated export R2 000
    L("inv2", "invoice", AR, 2_000_00, 0),
    L("inv2", "invoice", REV, 0, 2_000_00, "za_export_zero"),
    // Exempt R300
    L("inv3", "invoice", AR, 300_00, 0),
    L("inv3", "invoice", REV, 0, 300_00, "za_exempt"),
    // Credit note on inv1: R100 + R15
    L("cn1", "credit_note", AR, 0, 115_00),
    L("cn1", "credit_note", REV, 100_00, 0, "za_std_15"),
    L("cn1", "credit_note", OUT, 15_00, 0, "za_std_15", 100_00),
    // Bill: software R400 + R60 input VAT
    L("bill1", "bill", EXP, 400_00, 0, "za_std_15"),
    L("bill1", "bill", IN, 60_00, 0, "za_std_15", 400_00),
    L("bill1", "bill", AP, 0, 460_00),
    // Capital purchase: laptop R10 000 + R1 500
    L("bill2", "bill", FA, 10_000_00, 0, "za_capital_15"),
    L("bill2", "bill", IN, 1_500_00, 0, "za_capital_15", 10_000_00),
    L("bill2", "bill", AP, 0, 11_500_00),
    // A reversed invoice nets out
    L("inv4", "invoice", AR, 575_00, 0),
    L("inv4", "invoice", OUT, 0, 75_00, "za_std_15", 500_00),
    L("inv4", "invoice", REV, 0, 500_00, "za_std_15"),
    L("rev4", "invoice", AR, 0, 575_00),
    L("rev4", "invoice", OUT, 75_00, 0, "za_std_15", 500_00),
    L("rev4", "invoice", REV, 500_00, 0, "za_std_15"),
  ];

  it("maps journal lines to the SARS fields", () => {
    const { boxes, warnings } = computeVatReturn(journals, { f17: 0 });
    expect(boxes.f1).toBe(1_150_00);
    expect(boxes.f4).toBe(150_00);
    expect(boxes.f2A).toBe(2_000_00);
    expect(boxes.f2).toBe(0);
    expect(boxes.f3).toBe(300_00);
    expect(boxes.f18).toBe(15_00);
    expect(boxes.f15).toBe(60_00);
    expect(boxes.f14).toBe(1_500_00);
    expect(boxes.f13).toBe(150_00);
    expect(boxes.f19).toBe(60_00 + 1_500_00 + 15_00);
    expect(boxes.f20).toBe(150_00 - 1_575_00);
    expect(warnings).toEqual([]);
  });

  it("uses the income line as base when the VAT line has none, adds manual fields, and flags bad debts", () => {
    const lines: VatSourceLine[] = [
      L("a", "invoice", AR, 230_00, 0),
      L("a", "invoice", REV, 0, 200_00, "za_std_15"),
      L("a", "invoice", OUT, 0, 30_00, "za_std_15"),
      L("bd", "write_off", { ...acc("expense", "expense"), isBadDebtAccount: true }, 100_00, 0),
      L("bd", "write_off", OUT, 15_00, 0, "za_std_15"),
      L("bd", "write_off", AR, 0, 115_00),
    ];
    const { boxes } = computeVatReturn(lines, { f12: 5_00, f16: 2_00, f10: 115_00 });
    expect(boxes.f1).toBe(230_00);
    expect(boxes.f4).toBe(30_00);
    expect(boxes.f17).toBe(15_00);
    expect(boxes.f11).toBe(15_00);
    expect(boxes.f13).toBe(30_00 + 15_00 + 5_00);
    expect(boxes.f19).toBe(15_00 + 2_00);
  });

  it("estimates a missing base from the rate and warns", () => {
    const { boxes, warnings } = computeVatReturn([L("x", "invoice", AR, 115_00, 0), L("x", "invoice", OUT, 0, 15_00, "za_std_15"), L("x", "invoice", acc("current_liability", "liability"), 0, 100_00)]);
    expect(boxes.f1).toBe(115_00);
    expect(warnings[0]).toMatch(/estimated/);
  });
});

// ---------------------------------------------------------------------------

describe("reports", () => {
  const accounts = templateChart();
  const id = (code: string) => `a-${code}`;
  // Opening capital, a sale, a bill, depreciation, a loan, an asset purchase.
  const lines: Array<[string, number, number, string]> = [
    ["3000", 0, 50_000_00, "2025-12-31"],
    ["1000", 50_000_00, 0, "2025-12-31"],
    ["1100", 11_500_00, 0, "2026-03-05"],
    ["4000", 0, 10_000_00, "2026-03-05"],
    ["2100", 0, 1_500_00, "2026-03-05"],
    ["1000", 11_500_00, 0, "2026-03-20"],
    ["1100", 0, 11_500_00, "2026-03-20"],
    ["6130", 1_000_00, 0, "2026-04-02"],
    ["1400", 150_00, 0, "2026-04-02"],
    ["2000", 0, 1_150_00, "2026-04-02"],
    ["1510", 12_000_00, 0, "2026-04-10"],
    ["1000", 0, 12_000_00, "2026-04-10"],
    ["6150", 1_000_00, 0, "2026-04-30"],
    ["1590", 0, 1_000_00, "2026-04-30"],
    ["1000", 20_000_00, 0, "2026-05-01"],
    ["2800", 0, 20_000_00, "2026-05-01"],
    // Last year's profit
    ["1000", 3_000_00, 0, "2025-10-01"],
    ["4100", 0, 3_000_00, "2025-10-01"],
  ];
  function totals(from: string | null, to: string | null): AccountTotals[] {
    const map = new Map<string, AccountTotals>();
    for (const [code, d, c, date] of lines) {
      if (from && date < from) continue;
      if (to && date > to) continue;
      const t = map.get(id(code)) ?? { accountId: id(code), debitMinor: 0, creditMinor: 0 };
      t.debitMinor += d;
      t.creditMinor += c;
      map.set(id(code), t);
    }
    return [...map.values()];
  }

  it("trial balance balances", () => {
    const tb = trialBalance(accounts, totals(null, "2026-05-31"));
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebitMinor).toBe(tb.totalCreditMinor);
    expect(tb.lines.find((l) => l.code === "1000")!.debitMinor).toBe(72_500_00);
  });

  it("profit and loss", () => {
    const pnl = profitAndLoss(accounts, totals("2026-03-01", "2026-05-31"));
    expect(pnl.totalRevenueMinor).toBe(10_000_00);
    expect(pnl.totalExpensesMinor).toBe(2_000_00);
    expect(pnl.netProfitMinor).toBe(8_000_00);
  });

  it("balance sheet: assets = liabilities + equity, prior profit in retained earnings", () => {
    const bs = balanceSheet(accounts, totals(null, "2026-05-31"), totals("2026-03-01", "2026-05-31"));
    expect(bs.balanced).toBe(true);
    expect(bs.totalAssetsMinor).toBe(bs.totalLiabilitiesMinor + bs.totalEquityMinor);
    expect(bs.currentYearEarningsMinor).toBe(8_000_00);
    expect(bs.retainedEarningsMinor).toBe(3_000_00);
    expect(bs.nonCurrentAssets.find((l) => l.code === "1590")!.amountMinor).toBe(-1_000_00);
    expect(bs.nonCurrentLiabilities[0]!.amountMinor).toBe(20_000_00);
  });

  it("cash flow (indirect) reconciles to the change in cash", () => {
    const opening = totals(null, "2026-02-28").filter((t) => t.accountId === id("1000")).reduce((s, t) => s + t.debitMinor - t.creditMinor, 0);
    const cf = cashFlow(accounts, totals("2026-03-01", "2026-05-31"), opening);
    expect(cf.reconciles).toBe(true);
    expect(cf.netProfitMinor).toBe(8_000_00);
    expect(cf.investingTotalMinor).toBe(-12_000_00);
    expect(cf.financingTotalMinor).toBe(20_000_00);
    expect(cf.operating.find((l) => l.code === "1590")!.amountMinor).toBe(1_000_00);
    expect(cf.openingCashMinor).toBe(53_000_00);
    expect(cf.closingCashMinor).toBe(72_500_00);
    expect(cf.netChangeMinor).toBe(19_500_00);
  });

  it("general ledger running balance", () => {
    const bank = accounts.find((a) => a.code === "1000")!;
    const gl = generalLedger(bank, 53_000_00, [
      { journalId: "1", number: "JNL-1", date: "2026-03-20", memo: "", lineMemo: null, debitMinor: 11_500_00, creditMinor: 0 },
      { journalId: "2", number: "JNL-2", date: "2026-04-10", memo: "", lineMemo: null, debitMinor: 0, creditMinor: 12_000_00 },
    ]);
    expect(gl.rows.map((r) => r.balanceMinor)).toEqual([64_500_00, 52_500_00]);
    const ap = accounts.find((a) => a.code === "2000")!;
    expect(generalLedger(ap, 0, [{ journalId: "3", number: "J", date: "2026-04-02", memo: "", lineMemo: null, debitMinor: 0, creditMinor: 1_150_00 }]).closingMinor).toBe(1_150_00);
  });

  it("comparison and budget vs actual", () => {
    const cmp = compareProfitAndLoss(accounts, [totals("2026-04-01", "2026-04-30"), totals("2026-03-01", "2026-03-31")]);
    expect(cmp.netProfit).toEqual([-2_000_00, 10_000_00]);
    const bva = budgetVsActual(accounts, [{ accountCode: "4000", month: "2026-03", amountMinor: 8_000_00 }, { accountCode: "6130", month: "2026-04", amountMinor: 1_200_00 }], totals("2026-03-01", "2026-04-30"), ["2026-03", "2026-04"]);
    expect(bva.rows.find((r) => r.accountCode === "4000")).toMatchObject({ budgetMinor: 8_000_00, actualMinor: 10_000_00, varianceMinor: 2_000_00 });
    expect(bva.rows.find((r) => r.accountCode === "6130")).toMatchObject({ actualMinor: 1_000_00, varianceMinor: 200_00 });
  });

  it("aged receivables and the cash forecast", () => {
    const items = [
      { key: "a", number: "INV-1", counterpartyName: "Acme", outstandingMinor: 1_000_00, dueDate: "2026-09-20", issueDate: "2026-09-01", currency: "ZAR" },
      { key: "b", number: "INV-2", counterpartyName: "Acme", outstandingMinor: 500_00, dueDate: "2026-08-01", issueDate: "2026-07-01", currency: "ZAR" },
      { key: "c", number: "INV-3", counterpartyName: "Beta", outstandingMinor: 200_00, dueDate: "2026-05-01", issueDate: "2026-04-01", currency: "ZAR" },
    ];
    const aged = agedReport(items, "2026-09-26");
    expect(aged.totals).toMatchObject({ "1_30": 1_000_00, "31_60": 500_00, over_90: 200_00, total: 1_700_00 });
    const fc = cashForecast({
      asOf: "2026-09-26",
      months: 3,
      openingCashMinor: 10_000_00,
      receivables: [{ ...items[0]!, dueDate: "2026-10-15" }, items[1]!],
      payables: [{ key: "p", number: "B", counterpartyName: "S", outstandingMinor: 300_00, dueDate: "2026-09-30", issueDate: null, currency: "ZAR" }],
      recurringCostsMinor: 1_000_00,
      manual: [{ month: "2026-10", description: "Tax", amountMinor: -2_000_00, repeat: "none", untilMonth: null }, { month: "2026-09", description: "Rent in", amountMinor: 100_00, repeat: "monthly", untilMonth: "2026-10" }],
    });
    expect(fc.map((m) => m.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(fc[0]).toMatchObject({ receiptsMinor: 500_00, paymentsMinor: 300_00, recurringMinor: 700_00, manualMinor: 100_00, closingMinor: 10_000_00 + 500_00 - 300_00 - 700_00 + 100_00 });
    expect(fc[1]).toMatchObject({ receiptsMinor: 1_000_00, manualMinor: -1_900_00 });
    expect(fc[2]!.openingMinor).toBe(fc[1]!.closingMinor);
    expect(fc[2]!.manualMinor).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("fixed assets", () => {
  const laptop = { id: "as1", name: "Laptop", costMinor: 10_000_00, residualMinor: 1_000_00, lifeMonths: 36, depreciationStart: "2026-01-15", openingThrough: null, status: "active" as const, disposedDate: null };

  it("straight-line schedule adds up exactly", () => {
    const s = depreciationSchedule(laptop);
    expect(s).toHaveLength(36);
    expect(s[0]).toMatchObject({ month: "2026-01", amountMinor: 250_00 });
    expect(s.reduce((sum, r) => sum + r.amountMinor, 0)).toBe(9_000_00);
    expect(s[35]).toMatchObject({ month: "2028-12", bookValueMinor: 1_000_00 });
    const odd = depreciationSchedule({ ...laptop, costMinor: 1_000_00, residualMinor: 0, lifeMonths: 7 });
    expect(odd.reduce((sum, r) => sum + r.amountMinor, 0)).toBe(1_000_00);
    expect(Math.max(...odd.map((r) => r.amountMinor)) - Math.min(...odd.map((r) => r.amountMinor))).toBeLessThanOrEqual(1);
    expect(accumulatedThrough(laptop, "2026-06")).toBe(1_500_00);
  });

  it("due months skip posted, pre-cut-over and post-disposal months", () => {
    expect(dueDepreciation(laptop, "2026-03", new Set(["2026-01"])).map((r) => r.month)).toEqual(["2026-02", "2026-03"]);
    expect(dueDepreciation({ ...laptop, openingThrough: "2026-02" }, "2026-03", new Set()).map((r) => r.month)).toEqual(["2026-03"]);
    expect(dueDepreciation({ ...laptop, status: "disposed", disposedDate: "2026-03-10" }, "2026-12", new Set()).map((r) => r.month)).toEqual(["2026-01", "2026-02"]);
  });

  it("disposal lines balance and show the profit or loss", () => {
    const loss = disposalLines({ costMinor: 10_000_00, accumulatedMinor: 3_000_00, proceedsMinor: 5_000_00, assetCode: "1510", accumulatedCode: "1590", proceedsCode: "1000", gainLossCode: "6420", memo: "Laptop" });
    expect(loss.gainMinor).toBe(-2_000_00);
    const d = loss.lines.reduce((s, l) => s + l.debitMinor, 0);
    expect(d).toBe(loss.lines.reduce((s, l) => s + l.creditMinor, 0));
    const gain = disposalLines({ costMinor: 10_000_00, accumulatedMinor: 9_000_00, proceedsMinor: 2_000_00, assetCode: "1510", accumulatedCode: "1590", proceedsCode: "1000", gainLossCode: "6420", memo: "Laptop" });
    expect(gain.gainMinor).toBe(1_000_00);
    expect(gain.lines.find((l) => l.accountCode === "6420")).toMatchObject({ creditMinor: 1_000_00 });
  });
});

// ---------------------------------------------------------------------------

describe("FX revaluation", () => {
  it("unrealised gain on receivables, loss on payables, balanced", () => {
    const r = revalue(
      [
        { key: "inv", kind: "receivable", number: "INV-9", currency: "USD", outstandingMinor: 1_000_00, bookedRate: 18.5 },
        { key: "bill", kind: "payable", number: "B-9", currency: "EUR", outstandingMinor: 500_00, bookedRate: 20 },
        { key: "odd", kind: "receivable", number: "INV-X", currency: "JPY", outstandingMinor: 100, bookedRate: 0.12 },
      ],
      new Map([["USD", 19.2], ["EUR", 20.5]]),
    );
    expect(r.gainMinor).toBe(70_000);
    expect(r.lossMinor).toBe(25_000);
    expect(r.skipped.map((s) => s.key)).toEqual(["odd"]);
    const d = r.lines.reduce((s, l) => s + l.debitMinor, 0);
    expect(d).toBe(r.lines.reduce((s, l) => s + l.creditMinor, 0));
    expect(r.lines.find((l) => l.role === "ar")).toMatchObject({ debitMinor: 70_000 });
    expect(r.lines.find((l) => l.role === "ap")).toMatchObject({ creditMinor: 25_000 });
    // The audit example from the old platform: open 60% of USD 1000 at 18.5 → 19.2 = +R420.
    expect(revalue([{ key: "k", kind: "receivable", number: "n", currency: "USD", outstandingMinor: 600_00, bookedRate: 18.5 }], new Map([["USD", 19.2]])).gainMinor).toBe(420_00);
  });

  it("inverts frankfurter rates to ZAR per unit", () => {
    const m = invertRates({ USD: 0.05, EUR: 0.0476, BAD: 0 });
    expect(m.get("USD")).toBe(20);
    expect(m.get("EUR")).toBeCloseTo(21.008, 3);
    expect(m.has("BAD")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("cut-over", () => {
  it("parses an opening TB and refuses an unbalanced one unless asked", () => {
    const tb = parseOpeningTb("code,name,debit,credit\n1000,Bank,125000.00,\n1100,Debtors,20 000,00\n2000,Creditors,,5000\n3100,Retained earnings,,140000\nTotal,,145000,145000\n");
    expect(tb.lines).toHaveLength(4);
    expect(tb.differenceMinor).toBe(0);
    expect(openingJournalLines(tb, "3200", false)).toHaveLength(4);
    const off = parseOpeningTb("code;balance\n1000;1000.00\n3100;-900.00\n");
    expect(off.differenceMinor).toBe(100_00);
    expect(() => openingJournalLines(off, "3200", false)).toThrow(/does not balance/);
    const fixed = openingJournalLines(off, "3200", true);
    expect(fixed[fixed.length - 1]).toMatchObject({ accountCode: "3200", creditMinor: 100_00 });
    expect(fixed.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe("export files", () => {
  it("CSV quoting and formula neutralising", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(toCsv(["a"], [[1]])).toBe("a\r\n1\r\n");
  });

  it("ZIP archive with deflated files and valid CRCs", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const zip = zipFiles([{ name: "a.csv", data: "x,y\r\n1,2\r\n" }, { name: "b.json", data: JSON.stringify({ ok: true }) }]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    // First entry decompresses back to its content.
    const nameLen = view.getUint16(26, true);
    const size = view.getUint32(18, true);
    const data = zip.slice(30 + nameLen, 30 + nameLen + size);
    expect(new TextDecoder().decode(inflateRawSync(data))).toBe("x,y\r\n1,2\r\n");
  });

  it("tax codes cover the kit's codes", () => {
    expect(Object.keys(TAX_CODES)).toContain("za_std_15");
  });
});
