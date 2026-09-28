/**
 * Origin ids of the Paperclip issues Billing opens: `billing:<kind>:<id>`, one
 * prefix per kind of work. They are stable (one issue per purpose and
 * subject) and namespaced, so a done check never matches another module's
 * issue (the kit matches rules by origin id prefix only).
 */

/** Work Billing hands to agents; each has a done check (`donechecks.ts`). */
export const WORK_ORIGINS = {
  /** Daily "Drafts to send", one per company: `billing:drafts-to-send:<companyId>`. */
  drafts: "billing:drafts-to-send:",
  /** Weekly "Overdue invoices", one per company: `billing:overdue-invoices:<companyId>`. */
  overdue: "billing:overdue-invoices:",
  /** A customer answered a quote, one per quote: `billing:quote-reply:<quoteId>`. */
  quoteReply: "billing:quote-reply:",
  /** The CRM won a deal, one per deal: `billing:deal-won:<dealId>`. */
  dealWon: "billing:deal-won:",
  /** A supplier's invoice arrived by email, one per draft bill: `billing:bill-from-email:<billId>`. */
  billFromEmail: "billing:bill-from-email:",
} as const;

/** Decisions only a person makes (the Reviewer may check first); never done-checked. */
export const APPROVAL_ORIGINS = {
  invoiceSend: "billing:invoice-send:",
  quoteSend: "billing:quote-send:",
  invoicePay: "billing:invoice-pay:",
  recordPayment: "billing:record-payment:",
  creditNote: "billing:credit-note:",
  reminder: "billing:reminder:",
  paymentCheck: "billing:payment-check:",
  bankMatch: "billing:bank-match:",
  billApproval: "billing:bill-approval:",
} as const;

/** The id after a prefix, or null when the origin id has another prefix. */
export function originSubject(originId: string | null | undefined, prefix: string): string | null {
  if (!originId || !originId.startsWith(prefix)) return null;
  const id = originId.slice(prefix.length);
  return id || null;
}
