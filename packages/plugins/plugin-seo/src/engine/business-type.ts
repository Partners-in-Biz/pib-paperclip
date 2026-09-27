/**
 * Which 90-day plan fits a client, guessed from its CRM client profile (the
 * services it sells, its audience and website). Pure and browser-safe: the
 * SEO page uses it to preselect the plan when a sprint is created, and a
 * person (or the agent) confirms it.
 */
import type { BusinessType } from "../templates/plans.js";

export interface ProfileHint {
  services?: string[] | null;
  audience?: string | null;
  website?: string | null;
  name?: string | null;
}

export interface BusinessTypeGuess {
  type: BusinessType;
  /** The word that decided it, e.g. "attorneys". */
  word: string;
}

const RULES: Array<{ type: BusinessType; words: RegExp }> = [
  { type: "saas", words: /\b(saas|software|web ?apps?|mobile apps?|apps?|platform|api|subscription software|cloud software)\b/g },
  { type: "ecommerce", words: /\b(e-?commerce|online (?:shop|store)|web ?shop|shop online|buy online|online sales|nationwide delivery|we ship|shopify|woocommerce|takealot)\b/g },
  {
    type: "professional",
    words: /\b(law|legal|attorneys?|lawyers?|conveyanc\w*|notar\w*|litigation|accounting|accountants?|bookkeeping|tax|audit\w*|consult\w*|advisory|advisers?|advisors?|financial planning|wealth|insurance|architects?|engineering|recruit\w*|agency|agencies)\b/g,
  },
  {
    type: "local",
    words: /\b(guest ?houses?|b&b|bed and breakfast|lodges?|hotels?|accommodation|self-catering|restaurants?|caf[eé]s?|coffee shops?|salons?|spas?|beauty|clinics?|practice|physio\w*|biokinetic\w*|dentists?|dental|doctors?|medical|gyms?|fitness|clubs?|wrestling|sports?|schools?|academy|tutor\w*|plumb\w*|electric\w*|garden\w*|landscap\w*|clean\w*|repairs?|mechanics?|panel beat\w*|builders?|construction|painting|pest control|security|catering|weddings?|venues?|photograph\w*|vets?|veterinar\w*)\b/g,
  },
];

/** Ties go to the more specific plan: software, then online shop, then professional, then local. */
const PRIORITY: BusinessType[] = ["saas", "ecommerce", "professional", "local"];

function profileText(input: ProfileHint): string {
  const host = (() => {
    const raw = input.website?.trim();
    if (!raw) return "";
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  // "smith-attorneys.co.za" reads as "smith attorneys co za"; a Shopify store is a shop.
  const hostWords = host.endsWith(".myshopify.com") ? "shopify" : host.replace(/[.-]+/g, " ");
  return [...(input.services ?? []), input.audience ?? "", input.name ?? "", hostWords].join(" \n ").toLowerCase();
}

/**
 * The plan the profile points to, or null when it says nothing useful (the
 * page then defaults a client to a local service business and asks).
 */
export function suggestBusinessType(input: ProfileHint): BusinessTypeGuess | null {
  const text = profileText(input);
  if (!text.trim()) return null;
  let best: { type: BusinessType; count: number; word: string } | null = null;
  for (const type of PRIORITY) {
    const rule = RULES.find((r) => r.type === type)!;
    const matches = [...text.matchAll(rule.words)].map((m) => m[0]);
    if (matches.length === 0) continue;
    if (!best || matches.length > best.count) best = { type, count: matches.length, word: matches[0]! };
  }
  return best ? { type: best.type, word: best.word } : null;
}
