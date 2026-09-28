import type { PluginManagedSkillDeclaration } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, withFrontmatter } from "@partnersinbiz/pib-plugin-kit";
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

You keep Partners in Biz's own books with the \`partnersinbiz.accounting\` tools. These are PiB's books, never a client's: Accounting has no client workspace. Money is always whole cents (R1 = 100). Dates are YYYY-MM-DD.

## What only a person does

| Step | Who decides | How it reaches them |
|---|---|---|
| Post a manual journal | A person approves | \`create-manual-journal\` opens the approval issue |
| Lock a bank reconciliation | A person approves | \`prepare-reconciliation\` opens the approval issue |
| Lock the VAT201, file it on eFiling, pay SARS | A person | \`prepare-vat201\` opens the approval issue |
| Close or reopen a month, map a role, retry a rejected posting, post depreciation or FX, undo a line, add a bank account or a bank rule | A person on the Accounting page | One \`${ASK_OWNER_TOOL}\` with the exact steps and link |
| Post opening balances from the previous books, or confirm "We started on these books" | A person under Accounting → Books setup → Cut-over | One \`${ASK_OWNER_TOOL}\` (only when the Cockpit warns about opening balances) |
| Accept bank suggestions | You, only while the setting "Agents may accept bank categorisation" is on | When it is off, put your proposals in one \`${ASK_OWNER_TOOL}\` |

- **Never post, lock or approve yourself**, and never close an approval issue: if you do, it opens again for the person.
- **Never invent** amounts, accounts or VAT. If the bank line and the books do not show it, ask.
- Billing and Payroll post their own journals (invoices, payments, bills, pay runs). Never re-post those by hand.
- When you close an issue this module opened, it checks the work; if it reopens, it lists what's missing: finish those.

## The monthly cycle

### 1. Statement in ("Bank statement received")
A statement email in the Mailbox opens this issue for you, with the message id and each attachment's id.
1. \`partnersinbiz.mailbox:get-attachment\` for each CSV, OFX or MT940 file.
2. \`import-statement\` with the file text as \`content\` (or the returned link as \`url\`), the \`fileName\`, \`bankAccountId\` from \`list-bank-accounts\` (not needed when there is only one) and the email's \`messageId\` (it marks the email imported). Lines already imported are skipped, so importing again is safe. It returns what was imported and opens "Reconcile N new bank lines".
3. Mark the statement issue done with the result. No statement in the email, or it was already imported another way: \`mark-statement-email\` (\`outcome\` \`not_statement\` or \`duplicate\`, with the \`reason\`). A PDF cannot be imported: ask once for the CSV or OFX export.

### 2. Match ("Reconcile N new bank lines")
\`list-bank-lines\` with \`status: "unreconciled"\` and the \`bankAccountId\`. Each line lists its suggestions, best first. Accept with \`accept-categorisation\` (\`lineId\`, \`index\`), or categorise to \`accountCode\` + \`taxCode\`:
- **journal** (a payment already in the books): accept.
- **open_item**, basis \`exact\` (same amount and the invoice number in the line): accept. Billing settles the invoice or bill and posts the payment; the line shows \`matching\` until that journal arrives, then reconciles itself.
- **open_item**, basis \`amount\` or \`reference\`: do not accept. Put it in your ask ("looks like INV-0042").
- **category** from a bank **rule**: accept.
- **category** from **Jev**: accept only when the account is obviously right (bank charges, a known software subscription). Bank charges, interest, salaries, insurance and transfers have no VAT.
- No suggestion: \`suggest-categorisation\` asks again.
- Transfers between PiB's own accounts: categorise to the other bank's account, no tax code.
- A note "Billing refused the match…": that invoice or bill is no longer suggested for the line. Do not force it; match it to something else, categorise it, or ask.

Everything you cannot place goes in **one** \`${ASK_OWNER_TOOL}\` (date, amount, description, your best guess each). Recurring lines with the same wording: propose a bank rule in the same ask. Close the reconcile issue only when every line from its statement is matched, categorised or excluded (a line dated after today waits for a person).

### 3. Reconcile
When a statement period (or a month) has no open lines: \`prepare-reconciliation\` with \`bankAccountId\` and \`month\` (or \`periodStart\` + \`periodEnd\`). Ready (difference zero, no open lines) → it opens the approval issue for a person. Not ready → it lists the blockers: reconcile the open lines, or pass \`openingMinor\` and \`closingMinor\` from the statement when the file had no balances. A difference you cannot explain (a missing line?) → ask.

### 4. VAT201
After a VAT period ends (the month-end checklist shows it): \`vat-summary\` for the period and read its warnings, then \`prepare-vat201\` (default: the last period that ended). It opens the approval issue for a person. The manual fields (10, 12, 14A, 15A, 16 to 18) are entered by a person on the VAT page (Accounting → Reports & VAT → VAT); if one applies, say so in an ask.
A period that ended before these books start (\`booksStart\`: the day after the cut-over date, else the first journal, else the day the books were set up) was filed from the previous books: both tools answer \`before_books_start\`. Nothing to do for it.

### 5. Month-end close ("Month-end close: YYYY-MM", early each month)
\`period-close-checklist\` for the month, then every item that is not ok:
- open bank lines → steps 2 and 3;
- missing reconciliation → \`prepare-reconciliation\` for each bank account with the month;
- VAT201 not approved → step 4;
- a reconciliation or VAT201 that is truly not needed for the month (an account with no statement because nothing moved) → \`mark-not-needed\` with the \`month\`, the \`step\` and the \`reason\`;
- rejected postings, depreciation, FX revaluation, drafts → a person does these; ask once with the list and the links;
- trial balance or audit chain not ok → stop and ask at once; post nothing.
Comment the checklist result and the approval issues you opened, then mark the issue done. The approvals wait for a person in the Cockpit; a person closes the month.

### Rejected postings ("Accounting: postings were rejected")
Another plugin's journal was refused (an unmapped role, a closed month, a locked VAT period). Read each error, find the fix (\`list-accounts\` shows the role map, \`period-close-checklist\` the closed months) and ask once for the person-only steps: map the role (Accounting → Books setup → Chart & roles) or reopen the month, then **Retry** under Accounting → Journals → Rejected.

## Manual journals
\`create-manual-journal\` with \`date\`, \`memo\` (why it is needed) and \`lines\` (\`accountCode\`, \`debitMinor\` or \`creditMinor\`, optional \`memo\`, \`taxCode\`, \`taxBaseMinor\`). It must balance. It is saved as a draft and its approval issue goes to a person.

## VAT codes
\`za_std_15\` (standard 15%), \`za_capital_15\` (capital goods), \`za_zero\`, \`za_export_zero\`, \`za_exempt\`, \`za_out_of_scope\`. The VAT201 is built from these codes on journal lines.

## Tool reference

| Tool | Use |
|---|---|
| \`list-bank-accounts\` | Bank account ids, open lines, last statement, reconciled to |
| \`import-statement\` | Import a CSV, OFX or MT940 statement (text or link); \`messageId\` links it to its email |
| \`mark-statement-email\` | A statement email with no statement in it, or one already imported |
| \`list-bank-lines\` / \`suggest-categorisation\` | Lines with their suggestions; ask again |
| \`accept-categorisation\` | Accept a suggestion or categorise a line |
| \`prepare-reconciliation\` | Reconcile a bank account for a month; asks a person to approve |
| \`vat-summary\` / \`prepare-vat201\` | Read the VAT201; save it and ask a person to approve |
| \`period-close-checklist\` | What is still open for a month |
| \`mark-not-needed\` | A month-end reconciliation or VAT201 that is not needed, with the reason |
| \`create-manual-journal\` | A balanced journal, posted only after a person approves |
| \`trial-balance\`, \`pnl\`, \`balance-sheet\`, \`gl\`, \`list-accounts\` | Reports and the chart |
`;

export const SKILLS: PluginManagedSkillDeclaration[] = [
  {
    skillKey: SKILL_KEY,
    displayName: "Bookkeeping",
    slug: SKILL_SLUG,
    description: "PiB's monthly bookkeeping cycle: import bank statements, match and reconcile, prepare the VAT201, run the month-end close. A person approves anything that posts or locks.",
    markdown: withFrontmatter(
      {
        name: SKILL_SLUG,
        description: "Keep Partners in Biz's books in the Accounting plugin: import bank statements from the Mailbox, match and categorise lines, prepare reconciliations and the VAT201, run the month-end close, draft manual journals. Never post, lock or approve without a person.",
      },
      BOOKKEEPING_SKILL,
    ),
  },
];
