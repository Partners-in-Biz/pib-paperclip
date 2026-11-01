/**
 * A deterministic first check of ad copy (pure). It catches what a machine can: words the client's brand forbids, text longer than
 * a platform accepts, claims a platform's ad policy rejects, a missing or insecure landing page, special categories. The Reviewer then reads
 * the copy against the client's own brand profile; this check never replaces that and never clears copy on its own.
 *
 * `blocker` findings stop a proposal from going to review (a platform would reject it, or the client's brand forbids it).
 * `warn` findings go to the Reviewer with the proposal.
 */
import { AD_POLICY_CLAIMS, scoreCreative, type CreativePlatform, type CreativeRubricResult } from "@partnersinbiz/pib-plugin-kit";
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
  rubric?: CreativeRubricResult;
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
  // No copy limits yet: each platform's own ticket adds them.
  apple: [],
  tiktok: [],
  linkedin: [],
};

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
    for (const claim of AD_POLICY_CLAIMS) {
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

/**
 * Build rubric input from ad creative fields and call scoreCreative.
 * Merges rubric blockers into the findings, deduping banned_word blockers, and updates ok/blockers/warnings.
 */
export function checkCreativeWithRubric(input: CreativeInput, options: { bannedWords?: string[] } = {}): CreativeResult {
  const baseResult = checkCreative(input, options);

  // Build rubric input
  const platform = input.platform === "google" ? ("web" as CreativePlatform) : ("facebook" as CreativePlatform);
  const textParts = [
    input.headline ?? "",
    input.primaryText ?? "",
    input.description ?? "",
    input.callToAction ?? "",
  ].filter((s) => s.trim());
  const text = textParts.join("\n");

  const rubricResult = scoreCreative({
    platform,
    text,
    landingUrl: input.landingUrl ?? undefined,
    bannedWords: options.bannedWords ?? [],
  });

  // Merge rubric blockers into findings, deduping banned_word blockers
  const existingBannedWords = new Set(
    baseResult.findings
      .filter((f) => f.rule === "banned_word")
      .map((f) => {
        const match = f.text.match(/Uses "([^"]+)"/);
        return match ? match[1] : "";
      })
      .filter(Boolean),
  );

  const newFindings = [...baseResult.findings];
  for (const blocker of rubricResult.blockers) {
    if (blocker.rule === "banned_word") {
      const match = blocker.text.match(/Uses "([^"]+)"/);
      const word = match ? match[1] : "";
      if (existingBannedWords.has(word)) continue; // Dedupe
    }
    newFindings.push({
      level: "blocker",
      rule: blocker.rule,
      where: "copy",
      text: blocker.text,
    });
  }

  const blockers = newFindings.filter((f) => f.level === "blocker").length;
  const warnings = newFindings.length - blockers;

  return {
    ok: blockers === 0,
    blockers,
    warnings,
    findings: newFindings,
    rubric: rubricResult,
  };
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
