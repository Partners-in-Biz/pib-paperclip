/** Shown wherever an invoice has no number yet (a draft whose number is assigned on approval). */
export function invoiceNumberLabel(n: string | null | undefined): string {
  return n ?? "Draft";
}
