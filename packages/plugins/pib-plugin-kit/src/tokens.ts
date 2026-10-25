/**
 * Company tokens in agent-read text, and the lint that keeps the owner company's
 * names out of client companies' text.
 *
 * Skill source is written once for every company, but the host copies a skill's
 * markdown verbatim (the SDK takes no per-company content). So the kit renders
 * three tokens at declaration time to company-neutral defaults; an agent that
 * needs the real names calls `company-profile`.
 *
 * - `{{company}}`: "this company"
 * - `{{owner}}`: "the company owner"
 * - `{{ownerTitle}}`: "owner"
 *
 * Some skills document the merge fields of the email templates agents write
 * (`{{first_name}}`): those are listed in `MERGE_FIELDS` and pass through
 * untouched. Any other `{{name}}` is a mistake (a typo, or a placeholder nobody
 * fills) and throws, so the plugin's build and tests fail instead of a raw token
 * reaching an agent. A renderer caller that knows a value (the company's name,
 * say) can pass it in.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";

export const TOKEN_DEFAULTS = {
  company: "this company",
  owner: "the company owner",
  ownerTitle: "owner",
} as const;

/** Runtime merge fields that skill text documents for agents. They are not rendered here. */
export const MERGE_FIELDS: readonly string[] = ["email", "first_name", "last_name", "name", "unsubscribe_url"];

export type TokenName = keyof typeof TOKEN_DEFAULTS;

/** `{{name}}`, `{{ name }}`, `{{include:name}}`: anything token-shaped. */
const TOKEN_RE = /\{\{\s*([A-Za-z_][\w.:-]*)\s*\}\}/g;

export function renderTokens(text: string, values: Partial<Record<TokenName, string>> = {}): string {
  const unknown = new Set<string>();
  const out = text.replace(TOKEN_RE, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(TOKEN_DEFAULTS, name)) {
      if (!MERGE_FIELDS.includes(name)) unknown.add(name);
      return _match;
    }
    const given = values[name as TokenName]?.trim();
    return given || TOKEN_DEFAULTS[name as TokenName];
  });
  if (unknown.size > 0) {
    throw new Error(`Unknown token ${[...unknown].map((n) => `{{${n}}}`).join(", ")}. Known tokens: ${Object.keys(TOKEN_DEFAULTS).map((n) => `{{${n}}}`).join(", ")}; merge fields: ${MERGE_FIELDS.map((n) => `{{${n}}}`).join(", ")}.`);
  }
  return out;
}

/** The issue prefix of the owner company (the company that runs this instance). */
export const OWNER_COMPANY_PREFIX = "PAR";

/**
 * True for the owner company. The one place the literal lives: Campaigns and
 * Mailbox preferences use the same `issuePrefix` test. A failed lookup is
 * "not the owner", so client companies never receive owner-only rows.
 */
export async function isOwnerCompany(ctx: PluginContext, companyId: string): Promise<boolean> {
  try {
    const company = (await ctx.companies.get(companyId)) as { issuePrefix?: string | null } | null;
    return company?.issuePrefix === OWNER_COMPANY_PREFIX;
  } catch {
    return false;
  }
}

export interface BrandLeak {
  term: string;
  line: number;
  excerpt: string;
}

const BRAND_PATTERNS: Array<{ term: string; re: RegExp }> = [
  { term: "Peet", re: /\bPeet\b/g },
  { term: "Elon", re: /\bElon\b/g },
  { term: "Partners in Biz", re: /\bPartners in Biz\b/gi },
  { term: "PiB", re: /\bP(?:i|I)B\b/g },
];

/**
 * Product names that may keep the brand (an identifier a client really sees,
 * not a person or the agency). Starts empty: a text child adds an entry here
 * with the reason, or passes `allow` for one call.
 */
export const BRAND_ALLOWLIST: readonly string[] = [];

/**
 * The owner company's names found in `text`: the owner's first names, the agency
 * name and "PiB", minus any phrase in the allowlist. Plugin ids and skill keys
 * (`partnersinbiz.crm`, `pib-company-os`) are not matched.
 */
export function findBrandLeaks(text: string, options: { allow?: readonly string[] } = {}): BrandLeak[] {
  const allow = [...BRAND_ALLOWLIST, ...(options.allow ?? [])];
  const leaks: BrandLeak[] = [];
  text.split(/\r?\n/).forEach((original, index) => {
    let line = original;
    for (const phrase of allow) line = line.split(phrase).join(" ".repeat(phrase.length));
    for (const { term, re } of BRAND_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) leaks.push({ term, line: index + 1, excerpt: original.trim().slice(0, 160) });
    }
  });
  return leaks;
}
