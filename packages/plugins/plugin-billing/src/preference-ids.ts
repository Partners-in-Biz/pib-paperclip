/**
 * Preference ids that need no imports, so the Billing page (browser) and the worker agree on them
 * without the page bundling worker code.
 */

/** The bank details customers pay into. Changing one asks the owner to confirm first, and the server refuses without it. */
export const BANK_PREFERENCE_IDS = [
  "payment.accountName",
  "payment.bankName",
  "payment.accountNumber",
  "payment.branchCode",
  "payment.accountType",
  "payment.swift",
] as const;
