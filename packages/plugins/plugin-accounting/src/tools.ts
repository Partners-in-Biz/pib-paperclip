import type { JsonSchema, PluginToolDeclaration } from "@paperclipai/plugin-sdk";

const date = (description: string): JsonSchema => ({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: `${description} (YYYY-MM-DD).` });
const cents = (description: string): JsonSchema => ({ type: "integer", description: `${description} Whole cents (R1 = 100).` });
const TAX_CODES = ["za_std_15", "za_capital_15", "za_zero", "za_export_zero", "za_exempt", "za_out_of_scope"];
const taxCode = (description: string): JsonSchema => ({ type: "string", enum: TAX_CODES, description });
const bankAccountId: JsonSchema = {
  type: "string",
  description: "Accounting bank account id from list-bank-accounts. Leave out when the company has only one active bank account.",
};
const requestApproval: JsonSchema = {
  type: "boolean",
  description: "Open the approval issue for a person when it is ready (default true). false only checks.",
  default: true,
};

function schema(required: string[], properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", required, properties, additionalProperties: false };
}

export const ACCOUNTING_TOOLS: PluginToolDeclaration[] = [
  {
    name: "list-accounts",
    displayName: "List accounts",
    description: "The chart of accounts (code, name, type, kind) and the role map (which account each posting role uses).",
    parametersSchema: schema([], { activeOnly: { type: "boolean", description: "Only active accounts (default true). false includes inactive ones.", default: true } }),
  },
  {
    name: "list-bank-accounts",
    displayName: "List bank accounts",
    description:
      "The company's bank accounts with their ids (for import-statement and prepare-reconciliation), open line counts, the last statement imported and the last approved reconciliation.",
    parametersSchema: schema([], { includeInactive: { type: "boolean", description: "Also list bank accounts that were switched off (default false).", default: false } }),
  },
  {
    name: "import-statement",
    displayName: "Import bank statement",
    description:
      "Import a bank statement (CSV, OFX or MT940) for one bank account: pass the file text as content, or the https link the Mailbox get-attachment tool returned as url. Lines already imported are skipped, so importing again is safe. Suggests a match or category per new line and opens a \"Reconcile N new bank lines\" issue. Returns the lines imported, duplicates skipped and the next steps. PDFs cannot be imported.",
    parametersSchema: schema([], {
      bankAccountId,
      content: { type: "string", description: "The statement file's text (CSV, OFX or MT940), at most 1 MB. Give this or url." },
      url: { type: "string", pattern: "^https://", description: "An https download link to the file, e.g. the url from partnersinbiz.mailbox:get-attachment. Give this or content." },
      fileName: { type: "string", description: "The file's name, e.g. the email attachment's filename (shown on the statement list)." },
      format: { type: "string", enum: ["auto", "csv", "ofx", "mt940"], description: "File format (default auto: detected from the content).", default: "auto" },
    }),
  },
  {
    name: "list-bank-lines",
    displayName: "List bank lines",
    description:
      "Bank statement lines with their suggestions (best first): journal (a payment already in the books), open_item (an invoice or bill; basis exact, amount or reference) or category (from a bank rule or Jev). A note says why a line is waiting, e.g. Billing refused a match.",
    parametersSchema: schema([], {
      status: { type: "string", enum: ["unreconciled", "matching", "reconciled", "excluded"], description: "Only lines in this state. unreconciled = still to match or categorise; matching = sent to Billing, waiting for its payment journal." },
      bankAccountId: { type: "string", description: "Only this bank account (id from list-bank-accounts)." },
      from: date("First statement date to include"),
      to: date("Last statement date to include"),
      limit: { type: "integer", minimum: 1, maximum: 500, description: "At most this many lines (default 100).", default: 100 },
    }),
  },
  {
    name: "suggest-categorisation",
    displayName: "Suggest categorisation",
    description: "Recompute suggestions for unreconciled bank lines (rules, invoice and bill matches, journals) and ask Jev for an account when nothing else fits. Suggestions only; nothing posts.",
    parametersSchema: schema([], {
      lineIds: { type: "array", items: { type: "string" }, maxItems: 500, description: "Only these bank lines (ids from list-bank-lines)." },
      bankAccountId: { type: "string", description: "Only this bank account's unreconciled lines." },
    }),
  },
  {
    name: "accept-categorisation",
    displayName: "Accept categorisation",
    description:
      "Accept one of a bank line's suggestions (by index, default 0), or categorise the line to accountCode (+ taxCode). A category or journal match reconciles the line; an invoice or bill match goes to Billing, which settles it and posts the payment. Agents may do this only when the Accounting setting allows it, and may accept an invoice or bill match only when it is exact (same amount and the number in the bank line).",
    parametersSchema: schema(["lineId"], {
      lineId: { type: "string", description: "Bank line id from list-bank-lines." },
      index: { type: "integer", minimum: 0, description: "Which suggestion to accept (0 = the first, best one). Ignored when accountCode is given.", default: 0 },
      accountCode: { type: "string", description: "Categorise to this account code (from list-accounts) instead of accepting a suggestion." },
      taxCode: taxCode("VAT code with accountCode. Leave out for no VAT (bank charges, interest, salaries, insurance, transfers)."),
      memo: { type: "string", maxLength: 200, description: "Journal memo with accountCode (default: the bank line's description)." },
    }),
  },
  {
    name: "trial-balance",
    displayName: "Trial balance",
    description: "Debit and credit balance of every account at a date (default today), with totals and whether it balances.",
    parametersSchema: schema([], { asOf: date("Balances at the end of this day (default today)") }),
  },
  {
    name: "pnl",
    displayName: "Profit and loss",
    description: "Income statement for a date range (default: financial year to date): revenue, cost of sales, gross profit, other income, expenses, net profit.",
    parametersSchema: schema([], { from: date("First day (default: the start of the financial year)"), to: date("Last day (default today)") }),
  },
  {
    name: "balance-sheet",
    displayName: "Balance sheet",
    description: "Assets, liabilities and equity at a date (default today). Profit of earlier years shows under retained earnings; this year's as current year earnings.",
    parametersSchema: schema([], { asOf: date("Balances at the end of this day (default today)") }),
  },
  {
    name: "vat-summary",
    displayName: "VAT summary",
    description:
      "Read-only VAT201 fields for a VAT period, computed live from the journals (default: the period containing today, from the VAT category in the settings), with warnings, any saved return's status and booksStart (the first day these books cover; a period that ended before it shows status before_books_start). prepare-vat201 saves it and asks for approval.",
    parametersSchema: schema([], {
      periodStart: date("First day of the VAT period (give with periodEnd)"),
      periodEnd: date("Last day of the VAT period (give with periodStart)"),
      date: date("Any day in the VAT period (instead of periodStart and periodEnd)"),
    }),
  },
  {
    name: "gl",
    displayName: "General ledger",
    description: "Every journal line on one account in a range, with the opening balance and a running balance.",
    parametersSchema: schema(["accountCode"], {
      accountCode: { type: "string", description: "Account code from list-accounts, e.g. 1000 for the main bank account." },
      from: date("First day (default: the start of the month)"),
      to: date("Last day (default today)"),
    }),
  },
  {
    name: "create-manual-journal",
    displayName: "Create manual journal (draft)",
    description:
      "Save a balanced manual journal as a draft and open its approval issue for a person. It posts only when a person approves. Say why it is needed in memo. Never re-post journals that Billing or Payroll post themselves.",
    parametersSchema: schema(["date", "memo", "lines"], {
      date: date("Journal date"),
      memo: { type: "string", maxLength: 500, description: "Why this journal is needed (shown to the approver)." },
      lines: {
        type: "array",
        minItems: 2,
        description: "At least two lines; total debits must equal total credits.",
        items: {
          type: "object",
          required: ["accountCode"],
          properties: {
            accountCode: { type: "string", description: "Account code from list-accounts." },
            debitMinor: cents("Debit amount (leave out or 0 on a credit line)."),
            creditMinor: cents("Credit amount (leave out or 0 on a debit line)."),
            memo: { type: "string", maxLength: 200, description: "Line memo." },
            taxCode: taxCode("VAT code when this line carries VAT."),
            taxBaseMinor: cents("The amount the VAT was worked out on (with taxCode)."),
          },
          additionalProperties: false,
        },
      },
    }),
  },
  {
    name: "period-close-checklist",
    displayName: "Period close checklist",
    description: "Month-end close checklist for a month (default: last month): bank lines, reconciliations, rejected postings, drafts, depreciation, FX, VAT, trial balance and the audit chain. Each item says what is still missing.",
    parametersSchema: schema([], { month: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "Month to check, YYYY-MM (default: last month)." } }),
  },
  {
    name: "prepare-reconciliation",
    displayName: "Prepare bank reconciliation",
    description:
      "Reconcile one bank account for a month (or an exact statement period): opening balance plus the lines must equal the statement's closing balance, and no line may still be open. When it is ready it opens the approval issue for a person (who approves and locks it). Otherwise it returns the blockers and the next step. Balances default to the statement's own and the previous reconciliation.",
    parametersSchema: schema([], {
      bankAccountId,
      month: { type: "string", pattern: "^\\d{4}-\\d{2}$", description: "Calendar month YYYY-MM (default: last month). Ignored when periodStart and periodEnd are given." },
      periodStart: date("First day of the statement period (give with periodEnd)"),
      periodEnd: date("Last day of the statement period (give with periodStart)"),
      openingMinor: cents("Opening balance on the statement, when it cannot be read from the imported statement."),
      closingMinor: cents("Closing balance on the statement, when it cannot be read from the imported statement."),
      requestApproval,
    }),
  },
  {
    name: "prepare-vat201",
    displayName: "Prepare VAT201",
    description:
      "Save the VAT201 for a VAT period from the journals (default: the last period that has ended) and, once the period has ended, open its approval issue for a person. Approving locks the period; filing on eFiling and paying stay with the person. A period that ended before these books start is not prepared (status before_books_start: the previous books filed it). Check vat-summary's warnings first.",
    parametersSchema: schema([], {
      periodStart: date("First day of the VAT period (give with periodEnd)"),
      periodEnd: date("Last day of the VAT period (give with periodStart)"),
      date: date("Any day in the VAT period (instead of periodStart and periodEnd)"),
      requestApproval,
    }),
  },
];
