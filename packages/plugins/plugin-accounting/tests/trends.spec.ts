import { describe, expect, it } from "vitest";
import type { Account } from "../src/domain/chart.js";
import { expenseSplit, monthlyTrend, reconciliationByAccount, vatDueDate } from "../src/domain/trends.js";

const acc = (id: string, code: string, type: Account["type"], cashFlow: Account["cashFlow"] = "operating", name = id): Account =>
  ({ id, code, name, type, subtype: type === "income" ? "revenue" : type === "expense" ? "expense" : "bank", cashFlow, description: "", system: false, active: true }) as Account;

const accounts = [acc("bank", "1000", "asset", "cash"), acc("ar", "1100", "asset"), acc("sales", "4000", "income"), acc("rent", "6100", "expense", "operating", "Rent"), acc("soft", "6200", "expense", "operating", "Software")];

describe("overview trends", () => {
  it("builds income, expenses, profit and closing cash per month, including empty months", () => {
    const rows = monthlyTrend(
      accounts,
      [{ accountId: "bank", debitMinor: 50_000, creditMinor: 10_000 }],
      [
        { month: "2026-08", accountId: "sales", debitMinor: 0, creditMinor: 100_000 },
        { month: "2026-08", accountId: "ar", debitMinor: 100_000, creditMinor: 0 },
        { month: "2026-08", accountId: "rent", debitMinor: 30_000, creditMinor: 0 },
        { month: "2026-08", accountId: "bank", debitMinor: 0, creditMinor: 30_000 },
        { month: "2026-09", accountId: "bank", debitMinor: 100_000, creditMinor: 0 },
        { month: "2026-09", accountId: "ar", debitMinor: 0, creditMinor: 100_000 },
      ],
      ["2026-07", "2026-08", "2026-09"],
    );
    expect(rows).toEqual([
      { month: "2026-07", incomeMinor: 0, expensesMinor: 0, profitMinor: 0, closingCashMinor: 40_000 },
      { month: "2026-08", incomeMinor: 100_000, expensesMinor: 30_000, profitMinor: 70_000, closingCashMinor: 10_000 },
      { month: "2026-09", incomeMinor: 0, expensesMinor: 0, profitMinor: 0, closingCashMinor: 110_000 },
    ]);
  });

  it("splits expenses into the largest accounts and Other", () => {
    const totals = [
      { accountId: "rent", debitMinor: 30_000, creditMinor: 0 },
      { accountId: "soft", debitMinor: 5_000, creditMinor: 1_000 },
      { accountId: "sales", debitMinor: 0, creditMinor: 90_000 },
    ];
    expect(expenseSplit(accounts, totals)).toEqual([{ label: "Rent", code: "6100", amountMinor: 30_000 }, { label: "Software", code: "6200", amountMinor: 4_000 }]);
    expect(expenseSplit(accounts, totals, 1)).toEqual([{ label: "Rent", code: "6100", amountMinor: 30_000 }, { label: "Other", code: null, amountMinor: 4_000 }]);
  });

  it("puts the VAT201 due date on the last weekday of the month after the period", () => {
    expect(vatDueDate("2026-10-31")).toBe("2026-11-30"); // Monday
    expect(vatDueDate("2026-08-31")).toBe("2026-09-30"); // Wednesday
    expect(vatDueDate("2026-09-30")).toBe("2026-10-30"); // 31 Oct is a Saturday
    expect(vatDueDate("2026-12-31")).toBe("2027-01-29"); // 31 Jan 2027 is a Sunday
  });

  it("counts bank lines done and open per account", () => {
    expect(reconciliationByAccount([
      { bankAccountId: "fnb", status: "reconciled", count: 8 },
      { bankAccountId: "fnb", status: "excluded", count: 1 },
      { bankAccountId: "fnb", status: "unreconciled", count: 2 },
      { bankAccountId: "fnb", status: "matching", count: 1 },
      { bankAccountId: "amex", status: "unreconciled", count: 3 },
    ])).toEqual([
      { bankAccountId: "fnb", reconciled: 8, excluded: 1, open: 3, total: 12 },
      { bankAccountId: "amex", reconciled: 0, excluded: 0, open: 3, total: 3 },
    ]);
  });
});
