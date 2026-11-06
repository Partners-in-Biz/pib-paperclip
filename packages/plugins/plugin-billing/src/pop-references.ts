/**
 * Invoice numbers in free text. Pure, and apart from pop.ts so settle() can
 * use it too (pop.ts imports settle).
 */

/** "LUM-001" / "lum 1" / "LUM001" → "LUM-1"; null when it is not a document number. */
export function referenceKey(value: string): string | null {
  const match = /^([A-Za-z]{2,4})[\s_-]*0*(\d{1,6})$/.exec(String(value ?? "").trim());
  return match ? `${match[1]!.toUpperCase()}-${Number(match[2])}` : null;
}

/** Invoice-number-like references in free text (quote and credit-note numbers are skipped). */
export function findReferences(text: string): string[] {
  const out = new Set<string>();
  const re = /(?<![A-Za-z0-9]-)(?<![A-Za-z0-9])([A-Za-z]{2,4})[\s_-]?(\d{2,6})(?![0-9])/g;
  for (const match of String(text ?? "").matchAll(re)) {
    out.add(`${match[1]!.toUpperCase()}-${Number(match[2])}`);
  }
  return [...out];
}

/** Open invoices whose number appears in the text. */
export function matchByNumber<T extends { number: string }>(text: string, invoices: T[]): T[] {
  const refs = new Set(findReferences(text));
  if (refs.size === 0) return [];
  return invoices.filter((invoice) => {
    const key = referenceKey(invoice.number);
    return key != null && refs.has(key);
  });
}

/**
 * Does the text name this invoice and no other? Stricter than matchByNumber on
 * purpose: this closes a proof without a person looking, and a quoted email
 * thread can name other invoices. When in doubt the proof stays for a person.
 */
export function namesOnlyInvoice(text: string, number: string): boolean {
  const key = referenceKey(number);
  if (key == null) return false;
  const refs = findReferences(text);
  return refs.length === 1 && refs[0] === key;
}

/** The searchable text of a stored proof: subject, snippet and file names. */
export function popSearchText(pop: { subject?: string | null; snippet?: string | null; file_name?: string | null; attachments?: unknown }): string {
  const attachments = Array.isArray(pop.attachments) ? pop.attachments : [];
  const names = attachments.map((a) => String((a as { filename?: unknown } | null)?.filename ?? ""));
  return [pop.subject ?? "", pop.snippet ?? "", pop.file_name ?? "", ...names].join("\n");
}
