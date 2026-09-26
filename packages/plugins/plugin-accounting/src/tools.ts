import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const text = { type: "string" } satisfies JsonSchema;
const date = { type: "string", description: "YYYY-MM-DD" } satisfies JsonSchema;
const cents = { type: "integer", description: "Whole cents (R1 = 100)" } satisfies JsonSchema;

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const ACCOUNTING_TOOLS: PluginToolDeclaration[] = [
  {
    name: "list-accounts",
    displayName: "List accounts",
    description: "The chart of accounts (code, name, type, kind) and the role map (which account each posting role uses).",
    parametersSchema: schema([], { activeOnly: { type: "boolean" } }),
  },
  {
    name: "list-bank-lines",
    displayName: "List bank lines",
    description:
      "Bank statement lines with their suggestions (best first): journal (a payment already in the books), open_item (an invoice or bill; basis exact/amount/reference) or category (from a bank rule or Jev). Filter by status (unreconciled, matching, reconciled, excluded), bank account and dates.",
    parametersSchema: schema([], {
      status: { type: "string", enum: ["unreconciled", "matching", "reconciled", "excluded"] },
      bankAccountId: text,
      from: date,
      to: date,
      limit: { type: "integer", minimum: 1, maximum: 500 },
    }),
  },
  {
    name: "suggest-categorisation",
    displayName: "Suggest categorisation",
    description: "Recompute suggestions for bank lines (rules, invoice/bill matches, journals) and ask Jev for an account when nothing else fits. Suggestions only; nothing posts.",
    parametersSchema: schema([], { lineIds: { type: "array", items: text }, bankAccountId: text }),
  },
  {
    name: "accept-categorisation",
    displayName: "Accept categorisation",
    description:
      "Accept a bank line's suggestion (by index, default 0), or categorise it to accountCode (+ taxCode). Posts a bank journal or sends the invoice/bill match to Billing. Needs a board user unless the Accounting setting lets agents accept; agents may accept only exact invoice/bill matches.",
    parametersSchema: schema(["lineId"], {
      lineId: text,
      index: { type: "integer", minimum: 0 },
      accountCode: { type: "string", description: "Categorise to this account instead of a suggestion" },
      taxCode: { type: "string", enum: ["za_std_15", "za_capital_15", "za_zero", "za_export_zero", "za_exempt", "za_out_of_scope"] },
      memo: text,
    }),
  },
  {
    name: "trial-balance",
    displayName: "Trial balance",
    description: "Debit and credit balance of every account at a date (default today), with totals and whether it balances.",
    parametersSchema: schema([], { asOf: date }),
  },
  {
    name: "pnl",
    displayName: "Profit and loss",
    description: "Income statement for a date range (default: financial year to date): revenue, cost of sales, gross profit, other income, expenses, net profit.",
    parametersSchema: schema([], { from: date, to: date }),
  },
  {
    name: "balance-sheet",
    displayName: "Balance sheet",
    description: "Assets, liabilities and equity at a date (default today). Profit of earlier years shows under retained earnings; this year's as current year earnings.",
    parametersSchema: schema([], { asOf: date }),
  },
  {
    name: "vat-summary",
    displayName: "VAT summary",
    description: "VAT201 fields for a VAT period computed from the journals (default: the period containing today, per the VAT category in settings), plus warnings and any saved return's status.",
    parametersSchema: schema([], { periodStart: date, periodEnd: date, date }),
  },
  {
    name: "gl",
    displayName: "General ledger",
    description: "Every journal line on one account in a range, with the opening balance and a running balance.",
    parametersSchema: schema(["accountCode"], { accountCode: text, from: date, to: date }),
  },
  {
    name: "create-manual-journal",
    displayName: "Create manual journal (draft)",
    description:
      "Save a balanced manual journal as a draft and open its approval issue for a person. It posts only when a board user approves. Lines use accountCode with debitMinor or creditMinor (cents).",
    parametersSchema: schema(["date", "memo", "lines"], {
      date,
      memo: text,
      lines: {
        type: "array",
        minItems: 2,
        items: {
          type: "object",
          required: ["accountCode"],
          properties: {
            accountCode: text,
            debitMinor: cents,
            creditMinor: cents,
            memo: text,
            taxCode: { type: "string", enum: ["za_std_15", "za_capital_15", "za_zero", "za_export_zero", "za_exempt", "za_out_of_scope"] },
            taxBaseMinor: cents,
          },
          additionalProperties: false,
        },
      },
    }),
  },
  {
    name: "period-close-checklist",
    displayName: "Period close checklist",
    description: "Month-end close checklist for a month (default: last month): bank lines, reconciliations, rejected postings, drafts, depreciation, FX, VAT, trial balance and the audit chain.",
    parametersSchema: schema([], { month: { type: "string", description: "YYYY-MM" } }),
  },
];
