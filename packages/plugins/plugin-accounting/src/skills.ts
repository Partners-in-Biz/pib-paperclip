import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { withFrontmatter } from "@partnersinbiz/pib-plugin-kit";
import { PLUGIN_ID } from "./namespace.js";

export const AGENT_KEY = "bookkeeper";
export const SKILL_KEY = "bookkeeping";
export const SKILL_SLUG = "pib-bookkeeping";

/** Canonical key the host gives a plugin-managed skill: `plugin/<slug(pluginKey)>/<skillKey>`. */
export function canonicalSkillKey(pluginId: string, skillKey: string): string {
  const slug = pluginId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
  return `plugin/${slug}/${skillKey}`;
}

export const SKILL_CANONICAL_KEY = canonicalSkillKey(PLUGIN_ID, SKILL_KEY);

export const BOOKKEEPING_SKILL = `# Bookkeeping (Partners in Biz books)

You keep Partners in Biz's own books with the \`partnersinbiz.accounting\` tools. These are PiB's books, not a client's. Money is always in cents (R1 = 100).

## Rules that never bend

- **Never post, lock or approve on your own.** Manual journals go in as drafts (\`create-manual-journal\`); a person approves them. Bank reconciliations and VAT returns are approved by a board user in the Accounting page.
- Accept a bank suggestion only when you are sure, and only if the settings let agents accept (the tool tells you when they do not). Invoice/bill matches need an **exact** match (same amount and the invoice number in the bank line). Anything else: leave a comment on your issue for a person.
- Never invent amounts, accounts or VAT. If the evidence is not in the bank line or the books, ask.
- Billing and Payroll post their own journals (invoices, payments, bills, pay runs). Do not re-post those by hand; if one was rejected, report it.

## Reconcile the bank

1. \`list-bank-lines\` with \`status: "unreconciled"\` (add \`bankAccountId\` when there are several accounts). Each line lists its suggestions, best first.
2. For each line:
   - **journal** suggestion (a payment already in the books): accept it with \`accept-categorisation\` (\`lineId\`, \`index\`).
   - **open_item** with basis \`exact\`: accept it. Billing then settles the invoice or bill and posts the payment; the line shows "matching" until that journal arrives.
   - **open_item** with basis \`amount\` or \`reference\`: do not accept; say which invoice it looks like in a comment.
   - **category** from a bank **rule**: accept it.
   - **category** from **Jev**: accept only when the account is obviously right (e.g. bank charges, a known software subscription). Check the VAT: bank charges, interest, salaries, insurance and transfers have no VAT.
   - No suggestion: \`suggest-categorisation\` asks Jev again. If still unclear, comment.
3. Transfers between PiB's own accounts: categorise to the other bank's account, no tax code.
4. Recurring lines with the same wording: suggest a bank rule to a person in your comment (rules are set up in the page).

## Month-end close

Run \`period-close-checklist\` for the month (default: last month) and work through what is not ok:
- open bank lines → reconcile them (above);
- missing bank reconciliation → tell a person the statement balances you see; they prepare and approve it;
- rejected postings → list them with their errors (from the checklist detail) for a person;
- depreciation not posted, FX revaluation missing, VAT201 not approved → tell a person; these post or lock, so a person runs them;
- trial balance or audit chain not ok → stop and escalate at once.
Comment the checklist on your issue. A board user closes the period.

## Reports you can read

\`trial-balance\`, \`pnl\` (profit and loss; \`from\`/\`to\`), \`balance-sheet\` (\`asOf\`), \`vat-summary\` (a period's VAT201 fields, computed live), \`gl\` (one account's lines with a running balance; \`accountCode\`). \`list-accounts\` gives the chart and the role map.

## Manual journals

\`create-manual-journal\` with \`date\`, \`memo\` and \`lines\` (\`accountCode\`, \`debitMinor\`, \`creditMinor\`, optional \`memo\`, \`taxCode\`, \`taxBaseMinor\`). It must balance. It is saved as a draft and an approval issue opens for a person. Say why the journal is needed in \`memo\`.

## VAT codes

\`za_std_15\` (standard 15%), \`za_capital_15\` (capital goods), \`za_zero\`, \`za_export_zero\`, \`za_exempt\`, \`za_out_of_scope\`. The VAT201 is built from these codes on journal lines.
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: SKILL_KEY,
    displayName: "Bookkeeping",
    slug: SKILL_SLUG,
    description: "Reconcile PiB's bank, categorise lines, run the month-end close checklist; never post or lock without a person's approval.",
    markdown: withFrontmatter(
      {
        name: SKILL_SLUG,
        description: "Keep Partners in Biz's books in the Accounting plugin: reconcile the bank, categorise statement lines, run the month-end close checklist, draft manual journals. Never post, lock or approve without a person.",
      },
      BOOKKEEPING_SKILL,
    ),
  },
];
