/**
 * Event contracts between the PiB plugins.
 *
 * A plugin cannot call another plugin, so work crosses plugins as events.
 * Delivery is at-most-once: the sender keeps the request in its outbox
 * (`outbox.ts`) and re-emits it until the receiver answers with the matching
 * result event; the receiver dedupes by `key` (`receiveOnce`). An event
 * `name` emitted by plugin P arrives as `plugin.<P>.<name>`.
 *
 * Money is always integer minor units (cents) in the document's currency.
 */

export const PIB_PLUGINS = {
  crm: "partnersinbiz.crm",
  social: "partnersinbiz.social",
  seo: "partnersinbiz.seo",
  campaigns: "partnersinbiz.campaigns",
  billing: "partnersinbiz.billing",
  mailbox: "partnersinbiz.mailbox",
  partners: "partnersinbiz.partners",
  accounting: "partnersinbiz.accounting",
  payroll: "partnersinbiz.payroll",
  setup: "partnersinbiz.setup",
  cockpit: "partnersinbiz.cockpit",
} as const;

export type PibPluginKey = (typeof PIB_PLUGINS)[keyof typeof PIB_PLUGINS];

/** Full event type for an event `name` emitted by `pluginKey`. */
export function pluginEvent(pluginKey: string, name: string): `plugin.${string}` {
  return `plugin.${pluginKey}.${name}`;
}

// ---------------------------------------------------------------------------
// Mail (Mailbox sends and receives for every plugin)
// ---------------------------------------------------------------------------

export const MAIL_EVENTS = {
  /** Any plugin → Mailbox. */
  sendRequested: "mail.send.requested",
  /** Mailbox → the requesting plugin (filter on `context.plugin`). */
  sendResult: "mail.send.result",
  /** Mailbox → everyone: a new inbound message, already triaged. */
  received: "mail.received",
} as const;

/** Plugins whose `mail.send.requested` events the Mailbox listens to. */
export const MAIL_SENDERS: string[] = [
  PIB_PLUGINS.billing,
  PIB_PLUGINS.payroll,
  PIB_PLUGINS.campaigns,
  PIB_PLUGINS.crm,
  PIB_PLUGINS.accounting,
  PIB_PLUGINS.social,
  PIB_PLUGINS.seo,
];

export interface MailAddress {
  email: string;
  name?: string | null;
}

export interface MailAttachmentRef {
  /** Public or presigned URL the Mailbox downloads (R2). */
  url: string;
  filename: string;
  mime: string;
  bytes?: number;
}

export interface MailSendRequested {
  /** Outbox key; also the idempotency key at the Mailbox. */
  key: string;
  /** Mailbox account address to send from; the company's default account when omitted. */
  from?: string | null;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  html?: string | null;
  text?: string | null;
  attachments?: MailAttachmentRef[];
  /** Reply in this Gmail thread / to this message. */
  threadId?: string | null;
  inReplyToMessageId?: string | null;
  /** Who asked and why, so results and replies route back. */
  context: { plugin: string; kind: string; id: string; clientKind?: string | null; clientRef?: string | null };
  /** Gmail labels to add to the sent message, e.g. ["PiB/Invoices"]. */
  labels?: string[];
}

export interface MailSendResult {
  key: string;
  status: "sent" | "failed";
  messageId?: string | null;
  threadId?: string | null;
  sentAt?: string | null;
  error?: string | null;
  /** True when the failure will not go away on retry (bad address, no account). */
  permanent?: boolean;
  context: MailSendRequested["context"];
}

export const MAIL_CATEGORIES = [
  "lead",
  "client",
  "reply",
  "proof_of_payment",
  "invoice_or_bill",
  "bank_statement",
  "support",
  "newsletter",
  "notification",
  "spam",
  "personal",
  "other",
] as const;
export type MailCategory = (typeof MAIL_CATEGORIES)[number];

export interface MailReceived {
  key: string;
  accountAddress: string;
  messageId: string;
  threadId: string;
  /** RFC Message-ID header, for In-Reply-To matching. */
  rfcMessageId?: string | null;
  inReplyTo?: string | null;
  from: MailAddress;
  to: MailAddress[];
  subject: string;
  snippet: string;
  receivedAt: string;
  attachments: Array<{ attachmentId: string; filename: string; mime: string; bytes: number }>;
  triage: {
    category: MailCategory | null;
    urgency: number | null;
    needsReply: number | null;
    phishing: number | null;
    confidence: number | null;
    clientKind?: "company" | "contact" | null;
    clientRef?: string | null;
  };
  /** When this is a reply to a message a plugin sent, that message's context. */
  replyTo?: MailSendRequested["context"] | null;
  /** Set when this message is a delivery-failure notice for a message we sent. */
  bounce?: { recipients: string[]; rfcIds: string[] } | null;
}

// ---------------------------------------------------------------------------
// Ledger (Billing and Payroll post to Accounting)
// ---------------------------------------------------------------------------

export const LEDGER_EVENTS = {
  /** Billing / Payroll → Accounting. */
  postRequested: "ledger.post.requested",
  /** Accounting → the requesting plugin (filter on `source`). */
  postResult: "ledger.post.result",
} as const;

/** Plugins whose `ledger.post.requested` events Accounting listens to. */
export const LEDGER_SOURCES: string[] = [PIB_PLUGINS.billing, PIB_PLUGINS.payroll];

/**
 * Account roles let senders post without knowing the chart. Accounting maps
 * each role to an account in the company's book (editable per company).
 * `expense:<category>` and `revenue:<category>` fall back to the plain role.
 */
export const ACCOUNT_ROLES = [
  "bank",
  "cash",
  "ar",
  "ap",
  "revenue",
  "vat_output",
  "vat_input",
  "expense",
  "cost_of_sales",
  "salaries",
  "employer_contributions",
  "paye_payable",
  "uif_payable",
  "sdl_payable",
  "net_pay_clearing",
  "deductions_payable",
  "fx_gain",
  "fx_loss",
  "rounding",
  "discount_allowed",
  "bad_debts",
  "fixed_assets",
  "accumulated_depreciation",
  "depreciation",
  "retained_earnings",
  "opening_balance_equity",
  "owner_equity",
  "suspense",
] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** VAT codes shared by Billing, Accounting and Payroll (South Africa). */
export const TAX_CODES = {
  za_std_15: { rate: 0.15, label: "Standard 15%" },
  za_capital_15: { rate: 0.15, label: "Capital goods 15%" },
  za_zero: { rate: 0, label: "Zero-rated" },
  za_export_zero: { rate: 0, label: "Exports (zero-rated)" },
  za_exempt: { rate: 0, label: "Exempt" },
  za_out_of_scope: { rate: 0, label: "Out of scope" },
} as const;
export type TaxCode = keyof typeof TAX_CODES;

export interface LedgerLine {
  /** Either an account role (`ar`, `expense:software`) or an explicit account code. */
  role?: AccountRole | `expense:${string}` | `revenue:${string}`;
  accountCode?: string;
  debitMinor: number;
  creditMinor: number;
  memo?: string | null;
  taxCode?: TaxCode | null;
  /** Net amount the VAT on this line is charged on (for VAT201). */
  taxBaseMinor?: number | null;
  clientKind?: "company" | "contact" | null;
  clientRef?: string | null;
  /** Free dimensions, e.g. { employeeId } or { project }. */
  dimensions?: Record<string, string>;
}

export interface LedgerPostRequested {
  /** Outbox key and the journal's unique source key, e.g. `billing:invoice:<id>:issue`. */
  key: string;
  source: { plugin: string; kind: string; id: string };
  date: string; // YYYY-MM-DD
  memo: string;
  currency: string; // ISO 4217
  /** Rate to the book currency when `currency` differs (1 foreign unit = rate book units). */
  fxRate?: number | null;
  lines: LedgerLine[];
  /** Reverse the journal posted under this key instead of posting a new one. */
  reverseKey?: string | null;
}

export interface LedgerPostResult {
  key: string;
  status: "posted" | "rejected";
  journalId?: string | null;
  journalNumber?: string | null;
  error?: string | null;
  source: LedgerPostRequested["source"];
}

/** Sum check used by senders before enqueueing and by Accounting before posting. */
export function isBalanced(lines: LedgerLine[]): boolean {
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.debitMinor) || !Number.isInteger(line.creditMinor)) return false;
    if (line.debitMinor < 0 || line.creditMinor < 0) return false;
    debit += line.debitMinor;
    credit += line.creditMinor;
  }
  return lines.length >= 2 && debit === credit && debit > 0;
}

// ---------------------------------------------------------------------------
// Receivables / payables and bank matching (Billing ↔ Accounting)
// ---------------------------------------------------------------------------

export const OPEN_ITEM_EVENTS = {
  /** Billing → Accounting: an invoice or bill changed (projection upsert). */
  upserted: "open-item.upserted",
  /** Accounting → Billing: a bank line was matched to an open item. */
  bankMatched: "bank.matched",
  /** Billing → Accounting: the match was settled (or refused). */
  bankMatchResult: "bank.match.result",
} as const;

export interface OpenItemUpserted {
  key: string; // `invoice:<id>` / `bill:<id>`; projection upserts by key, last updatedAt wins
  kind: "receivable" | "payable";
  id: string;
  number: string;
  counterpartyName: string;
  clientKind?: "company" | "contact" | null;
  clientRef?: string | null;
  currency: string;
  totalMinor: number;
  outstandingMinor: number;
  issueDate: string;
  dueDate: string | null;
  /** References a payer may quote (invoice number, customer code). */
  references: string[];
  status: string;
  updatedAt: string;
}

export interface BankMatched {
  key: string; // `bank:<bankTxId>:<openItemKey>`
  bankTxId: string;
  bankAccountRole: "bank" | "cash";
  bankAccountCode: string;
  openItemKey: string;
  kind: "receivable" | "payable";
  amountMinor: number;
  currency: string;
  date: string;
  reference: string | null;
  /** How the match was made; `exact` = amount and reference both match. */
  basis: "exact" | "amount" | "manual";
  matchedBy: { userId?: string | null; agentId?: string | null };
}

export interface BankMatchResult {
  key: string;
  status: "settled" | "needs_review" | "rejected";
  paymentId?: string | null;
  error?: string | null;
}
