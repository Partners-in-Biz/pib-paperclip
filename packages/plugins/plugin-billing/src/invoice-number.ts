/** Shown wherever an invoice has no number yet (a draft whose number is assigned on approval). */
export function invoiceNumberLabel(n: string | null | undefined): string {
  return n ?? "Draft";
}

/**
 * The `number` of a draft created without one; `ensureInvoiceNumber` fills it on send approval. `InvoiceRow.number` stays typed
 * `string` (widening it flags ~90 readers of sent invoices, which always hold a number); only drafts carry this null.
 */
export const NO_NUMBER_YET = null as unknown as string;
