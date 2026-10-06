/**
 * The one sentence under each page in the client's approval email: why we changed it and how it should help search. The agent writes it
 * (create-preview `why`); when it is missing the plugin writes a plain one from the fields that changed. Never a promise of results.
 */
import type { PreviewChanges } from "./preview.js";

export const WHY_MAX = 320;

const PROMISE = /\b(guarantee[ds]?|certain(?:ly)?|definitely|will (?:rank|be (?:first|number|#)|double|triple|boost|increase|get you)|number (?:one|1)|#\s?1|top of google|first page of google|\d{2,}\s?%)/i;

/** The agent's sentence, trimmed, or the reason it cannot be used. */
export function checkWhy(raw: string | undefined): { why?: string; error?: string } {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return {};
  if (text.length > WHY_MAX) return { error: `why is ${text.length} characters; keep it to one short sentence (at most ${WHY_MAX}).` };
  if ((text.match(/[.!?](\s|$)/g) ?? []).length > 2) return { error: "why must be one sentence (two at most), written for the client." };
  const promise = PROMISE.exec(text);
  if (promise) return { error: `why promises a result ("${promise[0]}"). Say how the change should help (should, helps, makes it easier), never what it will achieve or by how much.` };
  return { why: text };
}

/** A plain sentence from what the preview changes, for a preview whose agent sent no why. */
export function fallbackWhy(changes: PreviewChanges): string {
  const head = changes.title || changes.metaDescription;
  const copy = changes.bodyHtml || changes.h1;
  if (head && copy) return "A clearer title and description plus fuller copy on this page should help search engines understand what it is about and give visitors the answers they look for.";
  if (head) return "A clearer title and description should help search engines understand this page and make it more likely to be clicked in the results.";
  if (copy) return "Fuller, clearer copy on this page should help it match what people search for and give visitors the answers they came for.";
  return "This change should make the page easier for search engines to understand and easier for visitors to use.";
}

export function whyOf(changes: PreviewChanges & { why?: string }): string {
  return checkWhy(changes.why).why ?? fallbackWhy(changes);
}
