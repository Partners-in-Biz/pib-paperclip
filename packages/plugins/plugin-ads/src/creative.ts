/**
 * A deterministic first check of ad copy (pure). It catches what a machine can: words the client's brand forbids, text longer than
 * a platform accepts, claims a platform's ad policy rejects, a missing or insecure landing page, special categories. The Reviewer then reads
 * the copy against the client's own brand profile; this check never replaces that and never clears copy on its own.
 *
 * `blocker` findings stop a proposal from going to review (a platform would reject it, or the client's brand forbids it).
 * `warn` findings go to the Reviewer with the proposal.
 */
import type { AdPlatform } from "./platforms.js";

export interface CreativeInput {
  platform: AdPlatform;
  headline?: string | null;
  primaryText?: string | null;
  description?: string | null;
  callToAction?: string | null;
  landingUrl?: string | null;
  /** Meta special ad categories declared on the campaign (CREDIT, EMPLOYMENT, HOUSING, ...). */
  specialAdCategories?: string[];
}

export interface CreativeFinding {
  level: "blocker" | "warn";
  rule: string;
  /** Which field, e.g. `headline`. */
  where: string;
  text: string;
}

export interface CreativeResult {
  ok: boolean;
  blockers: number;
  warnings: number;
  findings: CreativeFinding[];
}

const LIMITS: Record<AdPlatform, Array<{ field: keyof CreativeInput; max: number; hard: boolean; label: string }>> = {
  meta: [
    { field: "headline", max: 40, hard: false, label: "headline" },
    { field: "primaryText", max: 125, hard: false, label: "primary text" },
    { field: "description", max: 30, hard: false, label: "description" },
  ],
  google: [
    { field: "headline", max: 30, hard: true, label: "headline" },
    { field: "description", max: 90, hard: true, label: "description" },
  ],
};

/** Claims an ad platform's policy treats as misleading or unsubstantiated. A hit is for the Reviewer, not an automatic refusal. */
const CLAIMS: Array<{ rule: string; pattern: RegExp; hint: string }> = [
  { rule: "guarantee", pattern: /\b(guarantee[ds]?|guaranteed)\b/i, hint: "A guarantee needs proof and terms the page states. Remove it, or have the client confirm it." },
  { rule: "risk_free", pattern: /\b(risk[- ]free|no[- ]risk|zero risk)\b/i, hint: "No ad can promise no risk." },
  { rule: "superlative", pattern: /(?:^|\s)(#1|no\.?\s?1|number\s(?:one|1)|best in|world'?s best|the best)\b/i, hint: "A ranking claim needs a source the ad can show." },
  { rule: "absolute_pct", pattern: /\b100\s?%\s?(safe|effective|free|guaranteed|natural|results?)\b/i, hint: "Absolute claims are rejected by ad policy." },
  { rule: "miracle", pattern: /\b(miracle|instant(?:ly)? (?:results?|cure|relief)|cure[sd]?\b|get rich)/i, hint: "Health and wealth cure claims are rejected by ad policy." },
  { rule: "before_after", pattern: /\bbefore\s?(?:and|&|\/)\s?after\b/i, hint: "Before-and-after images and claims are restricted on Meta." },
  { rule: "personal_attribute", pattern: /\b(are you|do you have|did you)\s+(diabetic|depressed|anxious|overweight|obese|bankrupt|in debt|gay|pregnant|disabled|unemployed|sick)/i, hint: "Ads may not imply they know a personal attribute (health, finances, identity). Rephrase to describe the offer, not the person." },
  { rule: "urgency_caps", pattern: /(!{3,}|\b[A-Z]{4,}(?:\s+[A-Z]{4,}){2,})/, hint: "Shouting (capitals, repeated exclamation marks) lowers approval and trust." },
];

/** Topics that need a special ad category declared on Meta (and that Google restricts). */
const CATEGORY_WORDS: Array<{ category: string; pattern: RegExp }> = [
  { category: "CREDIT", pattern: /\b(loan|credit|mortgage|bond finance|finance for)\b/i },
  { category: "EMPLOYMENT", pattern: /\b(we'?re hiring|job opening|apply now for (?:a )?job|careers?|vacanc(?:y|ies))\b/i },
  { category: "HOUSING", pattern: /\b(homes? for sale|houses? for rent|apartments? to let|real estate listing|mortgage)\b/i },
  { category: "ISSUES_ELECTIONS_POLITICS", pattern: /\b(vote for|election|political party|referendum)\b/i },
];

const URL_SHORTENERS = /^(bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|buff\.ly|rebrand\.ly)$/i;

function words(list: string[]): RegExp[] {
  return list
    .map((word) => word.trim())
    .filter(Boolean)
    .map((word) => new RegExp(`(^|[^\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?=$|[^\\p{L}\\p{N}])`, "iu"));
}

export function checkCreative(input: CreativeInput, options: { bannedWords?: string[] } = {}): CreativeResult {
  const findings: CreativeFinding[] = [];
  const fields: Array<[string, string]> = [
    ["headline", input.headline ?? ""],
    ["primaryText", input.primaryText ?? ""],
    ["description", input.description ?? ""],
    ["callToAction", input.callToAction ?? ""],
  ];
  const banned = words(options.bannedWords ?? []);
  for (const [where, text] of fields) {
    if (!text.trim()) continue;
    banned.forEach((re, i) => {
      if (re.test(text)) findings.push({ level: "blocker", rule: "banned_word", where, text: `Uses "${(options.bannedWords ?? [])[i]}", which the client's brand profile bans.` });
    });
    for (const claim of CLAIMS) {
      if (claim.pattern.test(text)) findings.push({ level: "warn", rule: claim.rule, where, text: claim.hint });
    }
  }
  for (const limit of LIMITS[input.platform]) {
    const value = String(input[limit.field] ?? "");
    if (value.length > limit.max) {
      findings.push({
        level: limit.hard ? "blocker" : "warn",
        rule: "length",
        where: String(limit.field),
        text: `${limit.label[0]!.toUpperCase()}${limit.label.slice(1)} is ${value.length} characters; ${input.platform === "google" ? "Google accepts" : "Meta recommends"} at most ${limit.max}${limit.hard ? "" : " (longer text is cut off)"}.`,
      });
    }
  }
  const joined = fields.map(([, text]) => text).join(" \n ");
  const declared = new Set((input.specialAdCategories ?? []).map((c) => c.toUpperCase()));
  for (const { category, pattern } of CATEGORY_WORDS) {
    if (pattern.test(joined) && !declared.has(category)) {
      findings.push({ level: "warn", rule: "special_category", where: "copy", text: `The copy reads like a ${category.replace(/_/g, " ").toLowerCase()} ad. Declare the special ad category on the campaign, or confirm none applies.` });
    }
  }
  const url = (input.landingUrl ?? "").trim();
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") findings.push({ level: "blocker", rule: "landing_https", where: "landingUrl", text: "The landing page must use https://." });
      if (parsed.username || parsed.password) findings.push({ level: "blocker", rule: "landing_login", where: "landingUrl", text: "The landing page address must not carry a login." });
      if (URL_SHORTENERS.test(parsed.hostname)) findings.push({ level: "warn", rule: "landing_shortener", where: "landingUrl", text: "Link shorteners hide the destination and are often rejected. Use the real address." });
    } catch {
      findings.push({ level: "blocker", rule: "landing_invalid", where: "landingUrl", text: "The landing page is not a web address." });
    }
  }
  const blockers = findings.filter((f) => f.level === "blocker").length;
  return { ok: blockers === 0, blockers, warnings: findings.length - blockers, findings };
}

/** The creative fields the proposal carries, or null when it carries none (a budget change has no copy). */
export function creativeOf(payload: Record<string, unknown>): Omit<CreativeInput, "platform"> | null {
  const raw = payload.creative;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    headline: text(c.headline),
    primaryText: text(c.primaryText),
    description: text(c.description),
    callToAction: text(c.callToAction),
    landingUrl: text(c.landingUrl),
    specialAdCategories: Array.isArray(payload.specialAdCategories) ? payload.specialAdCategories.filter((s): s is string => typeof s === "string") : [],
  };
}
