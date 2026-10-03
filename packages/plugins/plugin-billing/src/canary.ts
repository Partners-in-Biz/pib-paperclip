/**
 * The CRM's canary client (audit Q1b-2): one internal test client the acceptance agent runs the whole
 * journey on. Billing honours it so a rehearsal never reaches a real person or the real books: its ids
 * start with `canary-`, its addresses end in `.invalid` (which no mail system can deliver to), and
 * everything outward for it is a draft or a dry run. See the CRM's canary reference.
 *
 * - no email is queued to a `.invalid` address (the document is marked sent, as when a customer has no
 *   address), so the Mailbox never tries it and nothing bounces;
 * - no payment link is made with a real provider (only the test provider);
 * - its invoices, payments and credit notes are not posted to the books: AR and revenue for a test
 *   client would be fake revenue in the real ledger.
 */
export const CANARY_PREFIX = "canary-";

export function isCanaryRef(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.startsWith(CANARY_PREFIX);
}

/** True for an address no real person can have (the canary domain, or any reserved `.invalid` name). */
export function isCanaryEmail(email: string | null | undefined): boolean {
  const domain = (email ?? "").trim().toLowerCase().split("@").pop() ?? "";
  return domain === "canary.invalid" || domain.endsWith(".invalid");
}

export function isCanaryCustomer(doc: { customer_ref?: string | null }): boolean {
  return isCanaryRef(doc.customer_ref);
}
