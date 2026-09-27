/**
 * Journal memos for people. Senders sometimes append database ids ("bank tx
 * 9a37a56a-…"). Posted memos are hash-chained and never edited, so the ids
 * are dropped when a memo is shown, not in the books.
 */

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** "bank tx <uuid>", "bank line: <uuid>", "tx #<uuid>", "id <uuid>", "ref <uuid>". */
const LABELLED_ID = new RegExp(`(?:\\bbank\\s+)?\\b(?:tx|txn|transaction|line|id|ref)\\s*[:#]?\\s*${UUID}`, "gi");
const BARE_ID = new RegExp(`\\b${UUID}\\b`, "gi");

/** The memo without database ids, tidied: "Payment for NOR-002 (Payment ref NOR-002 thanks)". "" when nothing is left. */
export function cleanMemo(memo: string | null | undefined): string {
  let text = String(memo ?? "");
  if (!text.trim()) return "";
  text = text.replace(LABELLED_ID, " ").replace(BARE_ID, " ");
  return text
    .replace(/\(\s*[,;:·–—-]*\s*\)|\[\s*[,;:·–—-]*\s*\]/g, " ") // brackets left empty
    .replace(/\s+([,;:.)\]])/g, "$1") // no space before punctuation
    .replace(/([,;:·–—-])(\s*[,;:·–—-])+/g, "$1") // separators left doubled
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/^[\s,;:·–—-]+|[\s,;:·–—-]+$/g, "")
    .trim();
}
