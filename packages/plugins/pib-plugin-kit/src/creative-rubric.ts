/**
 * The checkable creative bar (pure). A post, email or ad is scored out of 100 on five parts; it passes at 80 or more with no blocker.
 * A program checks what it can (words, counts, marks). Tone is a judgement, so it comes in as `tone`: unscored tone counts half,
 * a self-awarded score counts as unscored, and a reviewer's score needs one sentence of reason and is capped, so a tone score cannot carry a weak post.
 *
 * Claims: C27 moves the claim terms into the kit. Until then the caller passes `claimTerms`; with none, no claim is flagged.
 */
import { writingFindings, type WritingFinding } from "./writing.js";

export const CREATIVE_RUBRIC_WEIGHTS = { hook: 20, clarity: 20, brand: 20, cta: 15, format: 15 } as const;
export const CREATIVE_PASS_SCORE = 80;
export const UNSCORED_TONE = 10;
export const REVIEWER_TONE_CAP = 15;
export const CLARITY_PENALTY = 5;
export const HOOK_MAX_WORDS = 12;

export type CreativePlatform = "linkedin" | "instagram" | "facebook" | "x" | "email" | "web";

/** Longest text each platform accepts. */
export const PLATFORM_TEXT_LIMITS: Record<CreativePlatform, number> = { linkedin: 3000, instagram: 2200, facebook: 63206, x: 280, email: 20000, web: 20000 };

export interface ToneScore {
  /** 0 to 20. */
  score: number;
  source: "self" | "reviewer";
  /** One sentence. A reviewer score without it counts as unscored. */
  reason?: string;
}

export interface CreativeRubricInput {
  platform: CreativePlatform;
  text: string;
  /** One entry per image or video; empty or missing text means no alt text. */
  media?: Array<{ altText?: string | null }>;
  landingUrl?: string | null;
  bannedWords?: string[];
  tone?: ToneScore | null;
  /** Wordings that make a claim safe to use (the client's approved facts). */
  approvedFacts?: string[];
  /** Words that signal a claim about the business. Comes from the kit's claims module (C27). */
  claimTerms?: Array<{ re: RegExp; why: string }>;
}

export interface CreativeBlocker {
  rule: "banned_word" | "claim_unapproved";
  text: string;
}

export interface CreativeRubricResult {
  score: number;
  pass: boolean;
  parts: { hook: number; clarity: number; brand: number; cta: number; format: number };
  blockers: CreativeBlocker[];
  notes: string[];
  writing: WritingFinding[];
}

const HOOK_PATTERNS: RegExp[] = [
  /\?/,
  /\d/,
  /^(how|why|what|when|stop|most|never|always|don'?t|the (truth|secret|mistake|real)|nobody|everyone|you('re| are)?|if you)\b/i,
  /\b(mistake|secret|truth|myth|wrong|lesson|without|instead of)\b/i,
];

const ASK_PATTERNS: Array<[string, RegExp]> = [
  ["book", /\bbook\b/i],
  ["call", /\bcall (us|me)\b/i],
  ["email", /\bemail (us|me)\b/i],
  ["reply", /\breply\b/i],
  ["comment", /\bcomment\b/i],
  ["subscribe", /\bsubscribe\b/i],
  ["download", /\bdownload\b/i],
  ["sign up", /\bsign up\b|\bregister\b/i],
  ["buy", /\bbuy\b|\bshop\b|\border\b/i],
  ["learn more", /\blearn more\b|\bread (the|our|more)\b/i],
  ["visit", /\bvisit\b|\bclick\b/i],
  ["join", /\bjoin\b/i],
  ["try", /\btry\b|\bstart (your|a|the)\b/i],
  ["contact", /\bcontact\b|\bdm\b|\bmessage (us|me)\b/i],
  ["follow", /\bfollow\b/i],
  ["share", /\bshare\b/i],
  ["request", /\brequest\b|\bclaim\b|\bget (your|a|the)\b/i],
];

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const firstLine = (text: string): string => text.split(/\n/).map((l) => l.trim()).find(Boolean) ?? "";

function bannedHits(text: string, bannedWords: string[]): string[] {
  return bannedWords
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(w)}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text));
}

function claimBlockers(text: string, terms: Array<{ re: RegExp; why: string }>, facts: string[]): CreativeBlocker[] {
  const approved = facts.map(norm).filter(Boolean);
  const out: CreativeBlocker[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)) {
    const term = terms.find((t) => t.re.test(sentence));
    if (!term) continue;
    const n = norm(sentence);
    if (approved.some((fact) => fact.includes(n))) continue;
    out.push({ rule: "claim_unapproved", text: `Claims ${term.why} with no approved wording: ${sentence.length > 60 ? `${sentence.slice(0, 59)}…` : sentence}` });
  }
  return out;
}

/** The score for tone (0 to 20) and why it is that number. */
function toneScore(tone: ToneScore | null | undefined, notes: string[]): number {
  if (!tone) {
    notes.push(`Tone is not scored: it counts ${UNSCORED_TONE} of ${CREATIVE_RUBRIC_WEIGHTS.brand}.`);
    return UNSCORED_TONE;
  }
  if (tone.source === "self") {
    notes.push(`A self-awarded tone score counts ${UNSCORED_TONE}: only a reviewer's score, with a reason, moves it.`);
    return UNSCORED_TONE;
  }
  const raw = Math.max(0, Math.min(CREATIVE_RUBRIC_WEIGHTS.brand, Math.round(tone.score)));
  if (!tone.reason?.trim()) {
    notes.push(`The reviewer's tone score has no reason, so tone counts ${UNSCORED_TONE}.`);
    return UNSCORED_TONE;
  }
  if (raw > REVIEWER_TONE_CAP) notes.push(`Tone is capped at ${REVIEWER_TONE_CAP}.`);
  return Math.min(raw, REVIEWER_TONE_CAP);
}

export function scoreCreative(input: CreativeRubricInput): CreativeRubricResult {
  const notes: string[] = [];
  const blockers: CreativeBlocker[] = [];
  const text = input.text ?? "";

  const line = firstLine(text);
  const lineWords = line ? line.split(/\s+/).length : 0;
  let hook = 0;
  if (line) {
    if (lineWords <= HOOK_MAX_WORDS) hook += 10;
    else notes.push(`The first line is ${lineWords} words; keep it to ${HOOK_MAX_WORDS} or fewer.`);
    if (HOOK_PATTERNS.some((p) => p.test(line))) hook += 10;
    else notes.push("The first line has no hook: ask a question, use a number, or name a mistake or a myth.");
  }

  const writing = writingFindings(text);
  const clarity = Math.max(0, CREATIVE_RUBRIC_WEIGHTS.clarity - CLARITY_PENALTY * writing.length);

  const banned = bannedHits(text, input.bannedWords ?? []);
  for (const word of banned) blockers.push({ rule: "banned_word", text: `Uses "${word}", which the brand profile bans.` });
  const tone = toneScore(input.tone, notes);
  const brand = tone;

  blockers.push(...claimBlockers(text, input.claimTerms ?? [], input.approvedFacts ?? []));

  const asks = ASK_PATTERNS.filter(([, re]) => re.test(text)).length;
  const cta = asks === 1 ? CREATIVE_RUBRIC_WEIGHTS.cta : asks === 0 ? 0 : 5;
  if (asks === 0) notes.push("There is no ask. Give the reader one thing to do.");
  if (asks > 1) notes.push(`There are ${asks} asks. Keep one.`);

  let format = 0;
  const media = input.media ?? [];
  if (media.every((m) => m.altText?.trim())) format += 5;
  else notes.push("Every image or video needs alt text.");
  if (text.length <= PLATFORM_TEXT_LIMITS[input.platform]) format += 5;
  else notes.push(`The text is ${text.length} characters; ${input.platform} accepts ${PLATFORM_TEXT_LIMITS[input.platform]}.`);
  const url = (input.landingUrl ?? "").trim();
  let httpsOk = true;
  if (url) {
    try {
      httpsOk = new URL(url).protocol === "https:";
    } catch {
      httpsOk = false;
    }
  }
  if (httpsOk) format += 5;
  else notes.push("The landing page must be a valid https:// address.");

  const parts = { hook, clarity, brand, cta, format };
  const score = hook + clarity + brand + cta + format;
  return { score, pass: score >= CREATIVE_PASS_SCORE && blockers.length === 0, parts, blockers, notes, writing };
}
