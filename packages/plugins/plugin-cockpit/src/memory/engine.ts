/**
 * Company memory engine (pure, no I/O).
 *
 * Agents learn short facts; each task gets a small **brief** of only the facts
 * it needs. The pipeline:
 *
 * 1. **Scope** — candidates are the company's active, unexpired facts for the
 *    task's client(s) plus company-wide facts (never another client's).
 * 2. **Rank** — a cheap score (pinned, client and area match, keyword overlap,
 *    recency, past usefulness) keeps the best `candidatePool` for step 3.
 * 3. **Select** — Jev answers one yes/no question per candidate ("does this
 *    task need it?"), batched, and code keeps pinned rules plus facts at or
 *    above a low threshold (a missed fact costs more than an extra one).
 *    Without Jev, a keyword/recency baseline decides. Both are logged, so
 *    agent feedback can show which one to trust.
 * 4. **Pack** — at most `briefMaxFacts` facts and about `briefMaxTokens`.
 *
 * Nothing here grows with the size of memory except step 2's scan, which runs
 * in SQL-limited batches, so the brief an agent reads stays the same size no
 * matter how much the company learns.
 */
import { createHash } from "node:crypto";
import { MEMORY_LIMITS, type MemoryArea, type MemoryKind } from "@partnersinbiz/pib-plugin-kit";
import type { JevQuestions } from "@partnersinbiz/pib-plugin-kit";

// ---------------------------------------------------------------------------
// Tuning (one place; logged with every brief as `method`)
// ---------------------------------------------------------------------------

export const SELECTION = {
  /** Facts scanned per brief (SQL limit before ranking). */
  scanLimit: 400,
  /** Best-ranked facts sent to Jev. */
  candidatePool: 80,
  /** Facts per Jev request (one state + one yes/no question each). */
  jevChunk: 40,
  /** Keep a fact when Jev's probability is at least this (low on purpose: err on the side of loading). */
  jevThreshold: 0.35,
  /** Jev must answer quickly; otherwise the baseline brief is used. */
  jevTimeoutMs: 8000,
  /** Task text sent to Jev and used for keyword matching. */
  taskTextMaxChars: 1500,
  /** A brief for the same issue and agent is reused for this long when no fact changed. */
  cacheMinutes: 10,
  /** Active facts per client + area before the least valuable get archived. */
  scopeActiveCap: 120,
  /** Client picked by Jev only at or above this confidence. */
  clientChoiceMin: 0.6,
  /** Version of the ranking + selection rules, stored with every brief. */
  version: "v1",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FactStatus = "active" | "superseded" | "archived";
export type FactOrigin = "tool" | "harvest" | "person";

export interface MemoryFact {
  id: string;
  companyId: string;
  /** `company:<id>` / `contact:<id>`; null = company-wide (own work, applies to every task). */
  clientRef: string | null;
  clientName: string | null;
  area: MemoryArea;
  kind: MemoryKind;
  text: string;
  pinned: boolean;
  status: FactStatus;
  supersedes: string | null;
  supersededBy: string | null;
  sourceIssueId: string | null;
  sourceIdentifier: string | null;
  /** How it was saved: an agent's memory-add ("tool"), a **Learned:** line in a comment ("harvest"), or a person on the Memory tab ("person"). */
  origin: FactOrigin;
  sourceCommentId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  expiresAt: string | null;
  useCount: number;
  lastUsedAt: string | null;
  helpfulCount: number;
  noiseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskContext {
  issueId: string | null;
  identifier: string | null;
  title: string;
  description: string;
  /** Parent issues' titles, project name: extra words for matching, not sent as the task. */
  context: string[];
  clientRefs: string[];
  clientNames: string[];
  area: MemoryArea | null;
}

export interface RankedFact {
  fact: MemoryFact;
  score: number;
  lexical: number;
  clientMatch: boolean;
  areaMatch: boolean;
  /**
   * Pinned and applies to this task, so it is always in the brief: a client's own pinned rule, a company-wide rule
   * with area "general", or a company-wide rule for the task's area. Another area's company-wide rule (bookkeeping,
   * mailbox) is left to the normal pick, so it stops taking brief slots from client work.
   */
  pinApplies: boolean;
}

export type SelectionMethod = "jev" | "baseline" | "empty";

export interface Selection {
  method: SelectionMethod;
  selected: RankedFact[];
  /** What the baseline would have picked (logged for comparison). */
  baselineIds: string[];
  /** Jev probability per fact id (only for `jev`). */
  scores: Record<string, number>;
  tokens: number;
  candidateCount: number;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** One line, trimmed, no list marker. */
export function normalizeFactText(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .trim();
}

const STOP = new Set(
  (
    "the and for are but not you all any can had her was one our out has have him his how its may new now see way who did get let put say she too use that this with from they them then than there their what when where which while will would into onto over under about after before again also been being both each few more most other some such only own same very just should could does done doing make made much many must need needs task work client please via per etc our your we us it is to of in on at by as or an be if so no do up a i".split(
      " ",
    )
  ),
);

/** Lowercase word stems (≥3 letters, no stop words). Crude on purpose: fast, language-agnostic enough. */
export function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .match(/[a-z0-9]+/g);
  if (!words) return [];
  const out: string[] = [];
  for (const raw of words) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ied")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** About four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Same scope + same words (order, case and punctuation ignored) = same fact. */
export function factHash(clientRef: string | null, text: string): string {
  const words = normalizeFactText(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return createHash("sha256").update(`${clientRef ?? "*"}\u0000${words.join(" ")}`).digest("hex").slice(0, 32);
}

/** Share of the smaller token set found in the other (0–1). Used to spot near-duplicates. */
export function overlap(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const t of x) if (y.has(t)) common += 1;
  return common / Math.min(x.size, y.size);
}

// ---------------------------------------------------------------------------
// Safety: facts are shared with every agent, so secrets never go in
// ---------------------------------------------------------------------------

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}/, "an API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "a Google API key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./, "a token (JWT)"],
  [/\b(?:password|passwd|pwd|passcode|pin|secret|api[_ -]?key|token)\s*[:=]\s*\S{4,}/i, "a password or key"],
  [/\b[A-Fa-f0-9]{40,}\b/, "a long secret-looking value"],
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}(?=\s|$)/, "a long secret-looking value"],
];

/** Why this text must not be stored (a secret, a card or ID number), or null when it is fine. */
export function sensitiveReason(text: string): string | null {
  for (const [pattern, what] of SECRET_PATTERNS) if (pattern.test(text)) return what;
  for (const match of text.matchAll(/\b(?:\d[ -]?){13,19}\b/g)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length === 13 && /^\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{7}$/.test(digits) && luhn(digits)) return "an ID number";
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "a card number";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Clients whose name appears in the text (whole words, case-insensitive,
 * names of 3+ characters). `known` maps client ref → name.
 */
export function clientsMentioned(text: string, known: Array<{ clientRef: string; clientName: string }>): string[] {
  const found: string[] = [];
  const hay = text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (const { clientRef, clientName } of known) {
    const name = clientName.normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
    if (name.length < 3 || found.includes(clientRef)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(name)}($|[^\\p{L}\\p{N}])`, "iu");
    if (re.test(hay)) found.push(clientRef);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** Text an agent's task is judged on (title + description + context), trimmed. */
export function taskText(task: TaskContext): string {
  return [task.title, task.description, ...task.context].filter(Boolean).join("\n").slice(0, SELECTION.taskTextMaxChars * 2);
}

function daysBetween(a: string, now: Date): number {
  const t = Date.parse(a);
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 86_400_000) : 365;
}

/** True when the fact is active and not expired at `now`. */
export function isLive(fact: MemoryFact, now: Date): boolean {
  if (fact.status !== "active") return false;
  if (fact.expiresAt) {
    const t = Date.parse(fact.expiresAt);
    if (Number.isFinite(t) && t <= now.getTime()) return false;
  }
  return true;
}

/**
 * Cheap relevance score used to (a) keep the best candidates for Jev and
 * (b) decide on its own when Jev is not available.
 */
export function rankFacts(facts: MemoryFact[], task: TaskContext, now: Date): RankedFact[] {
  // Client names are matched separately (clientMatch); as keywords they would
  // make every fact about the client look relevant to every task for it.
  const nameTokens = new Set(tokenize([...task.clientNames, ...facts.map((f) => f.clientName ?? "")].join(" ")));
  const taskTokens = new Set(tokenize(taskText(task)).filter((t) => !nameTokens.has(t)));
  // Inverse document frequency over the candidates, so common words count less.
  const df = new Map<string, number>();
  const factTokens = facts.map((fact) => {
    const tokens = [...new Set(tokenize(fact.text))].filter((t) => !nameTokens.has(t));
    for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
    return tokens;
  });
  const n = Math.max(facts.length, 1);
  const ranked = facts.map((fact, i) => {
    const tokens = factTokens[i]!;
    let lexical = 0;
    for (const t of tokens) if (taskTokens.has(t)) lexical += Math.log(1 + n / (df.get(t) ?? 1));
    lexical = tokens.length ? lexical / Math.sqrt(tokens.length) : 0;
    const clientMatch = fact.clientRef !== null && task.clientRefs.includes(fact.clientRef);
    const areaMatch = task.area !== null && (fact.area === task.area || fact.area === "general");
    const pinApplies = fact.pinned && (fact.clientRef !== null || fact.area === "general" || areaMatch);
    const recency = Math.max(0, 1 - daysBetween(fact.updatedAt || fact.createdAt, now) / 180);
    const score =
      (fact.pinned ? 3 : 0) +
      (clientMatch ? 1.5 : 0) +
      (areaMatch ? 1.5 : 0) +
      Math.min(lexical, 3) +
      0.5 * recency +
      0.3 * Math.log1p(fact.helpfulCount) -
      0.6 * Math.log1p(fact.noiseCount) +
      (fact.kind === "rule" || fact.kind === "warning" ? 0.3 : 0);
    return { fact, score, lexical, clientMatch, areaMatch, pinApplies };
  });
  return ranked.sort((a, b) => b.score - a.score || b.fact.updatedAt.localeCompare(a.fact.updatedAt) || a.fact.id.localeCompare(b.fact.id));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** One brief line. Ids let agents give feedback and supersede. */
export function factLine(fact: MemoryFact): string {
  const scope = [fact.clientName ?? (fact.clientRef ? "client" : "company-wide"), fact.area, fact.kind !== "fact" ? fact.kind : null, fact.pinned ? "pinned" : null, fact.status === "archived" ? "archived" : null]
    .filter(Boolean)
    .join(" · ");
  const source = [fact.sourceIdentifier, fact.createdAt ? fact.createdAt.slice(0, 10) : null].filter(Boolean).join(", ");
  return `- [${fact.id}] (${scope}) ${fact.text}${source ? ` — ${source}` : ""}`;
}

/** Fill the brief in order until the fact or token cap is reached. Pinned facts come first. */
export function pack(ordered: RankedFact[], limits: { maxFacts: number; maxTokens: number } = { maxFacts: MEMORY_LIMITS.briefMaxFacts, maxTokens: MEMORY_LIMITS.briefMaxTokens }): { facts: RankedFact[]; tokens: number } {
  const out: RankedFact[] = [];
  let tokens = 0;
  const seen = new Set<string>();
  const pinned = ordered.filter((r) => r.pinApplies).slice(0, MEMORY_LIMITS.pinnedMaxPerScope * 2);
  for (const r of [...pinned, ...ordered.filter((x) => !x.pinApplies)]) {
    if (seen.has(r.fact.id)) continue;
    if (out.length >= limits.maxFacts) break;
    const cost = estimateTokens(factLine(r.fact)) + 1;
    if (tokens + cost > limits.maxTokens) continue;
    out.push(r);
    tokens += cost;
    seen.add(r.fact.id);
  }
  return { facts: out, tokens };
}

/**
 * Baseline without Jev: pinned rules, then facts that share words with the
 * task or belong to the task's client and area, best rank first.
 */
export function baselineSelect(ranked: RankedFact[]): RankedFact[] {
  return ranked.filter((r) => r.pinApplies || r.lexical > 0 || (r.clientMatch && r.areaMatch));
}

/** Jev's picks: the pinned rules that apply always, then facts at or above the threshold, most likely first. */
export function jevSelect(ranked: RankedFact[], scores: Record<string, number>, threshold: number = SELECTION.jevThreshold): RankedFact[] {
  const pinned = ranked.filter((r) => r.pinApplies);
  const picked = ranked
    .filter((r) => !r.pinApplies && typeof scores[r.fact.id] === "number" && scores[r.fact.id]! >= threshold)
    .sort((a, b) => scores[b.fact.id]! - scores[a.fact.id]! || b.score - a.score);
  return [...pinned, ...picked];
}

// ---------------------------------------------------------------------------
// Jev requests
// ---------------------------------------------------------------------------

export interface JevBatch {
  /** Question key → fact id. */
  keys: Record<string, string>;
  state: Record<string, unknown>;
  questions: JevQuestions;
}

const NEED_INSTRUCTIONS = (key: string) =>
  `The state has a task an agent is about to do (\`task\`) and short facts the company learned earlier (\`facts\`). Would the agent do \`task\` better, or avoid a mistake, by knowing \`facts.${key}\`?`;

const NEED_CRITERIA = {
  true: "Yes when the fact is about the same client, website, account, system, product, channel or type of work as the task, or states a preference, rule, warning or lesson that applies when doing this task.",
  false: "No when the fact is about a different channel or type of work, only records something that happened without changing how this task should be done, or has nothing to do with the task.",
};

/** Batches of at most `jevChunk` facts, each with the task, one yes/no question per fact. */
export function jevBatches(task: TaskContext, candidates: RankedFact[], chunk: number = SELECTION.jevChunk): JevBatch[] {
  const taskState = {
    title: task.title.slice(0, 300),
    description: task.description.slice(0, SELECTION.taskTextMaxChars),
    client: task.clientNames.length ? task.clientNames.join(", ") : "none (own work or unknown)",
    area: task.area ?? "unknown",
    context: task.context.join(" / ").slice(0, 400) || undefined,
  };
  const batches: JevBatch[] = [];
  for (let start = 0; start < candidates.length; start += chunk) {
    const slice = candidates.slice(start, start + chunk);
    const keys: Record<string, string> = {};
    const facts: Record<string, string> = {};
    const questions: JevQuestions = {};
    slice.forEach((r, i) => {
      const key = `f${i + 1}`;
      keys[key] = r.fact.id;
      const about = [r.fact.clientName ?? (r.fact.clientRef ? "a client" : "the whole company"), r.fact.area, r.fact.kind].join(", ");
      facts[key] = `${r.fact.text} (about: ${about})`;
      questions[key] = { type: "noul", instructions: NEED_INSTRUCTIONS(key), criteria: NEED_CRITERIA };
    });
    batches.push({ keys, state: { task: taskState, facts }, questions });
  }
  return batches;
}

/** Jev's yes-probability per fact id from answered batches (missing answers are left out). */
export function scoresFrom(batches: JevBatch[], answers: Array<Record<string, { type: string; noul?: number }> | null>): Record<string, number> {
  const scores: Record<string, number> = {};
  batches.forEach((batch, i) => {
    const a = answers[i];
    if (!a) return;
    for (const [key, factId] of Object.entries(batch.keys)) {
      const answer = a[key];
      if (answer && answer.type === "noul" && typeof answer.noul === "number" && Number.isFinite(answer.noul)) scores[factId] = answer.noul;
    }
  });
  return scores;
}

/** Choice question: which known client is the task for (used only when the text names none). */
export function clientChoice(task: TaskContext, known: Array<{ clientRef: string; clientName: string }>): { state: Record<string, unknown>; questions: JevQuestions; options: Record<string, string> } | null {
  const unique = known.filter((k, i) => known.findIndex((x) => x.clientRef === k.clientRef) === i).slice(0, 200);
  if (unique.length === 0) return null;
  const options: Record<string, string> = {};
  const criteria: Record<string, string | null> = {};
  unique.forEach((k, i) => {
    const key = `c${i + 1}`;
    options[key] = k.clientRef;
    criteria[key] = `The task is work for or about the client "${k.clientName}".`;
  });
  criteria.none = "The task is not for any of these clients: it is the company's own work, internal, or for a client not listed.";
  return {
    state: { task: { title: task.title.slice(0, 300), description: task.description.slice(0, SELECTION.taskTextMaxChars), context: task.context.join(" / ").slice(0, 400) } },
    questions: { client: { type: "choice", instructions: "Which client is `task` for?", criteria } },
    options,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The last line of every brief. Feedback is the only way to learn whether a
 * brief helped, and it was zero for 199 briefs: so it asks for a report even
 * when everything helped ("helpful"), which an empty report cannot say.
 */
export const FEEDBACK_PROMPT =
  'Follow these unless the task or a person says otherwise. When you close the task, call memory-feedback once with this brief id: helpful (ids that helped, or ["all"]), noise (ids that did not), missing or wrong. No report tells us nothing.';

export function renderBrief(input: { task: TaskContext; selection: Selection; totalFacts: number; briefId: string }): string {
  const { task, selection } = input;
  const label = task.identifier ?? task.title.slice(0, 60);
  if (selection.selected.length === 0) {
    return input.totalFacts === 0
      ? `Memory brief for ${label}: the company has no stored facts yet. Save what you learn with memory-add when you close the task.`
      : `Memory brief for ${label}: none of the ${input.totalFacts} stored facts apply to this task. If you expected one, search with memory-search.`;
  }
  const how = selection.method === "jev" ? "picked by Jev" : "picked by keyword and recency (Jev not set up)";
  const lines = selection.selected.map((r) => factLine(r.fact));
  return [
    `Memory brief for ${label} (${selection.selected.length} of ${input.totalFacts} facts, ${how}; brief ${input.briefId}):`,
    ...lines,
    FEEDBACK_PROMPT,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// **Learned:** lines in comments (saved automatically)
// ---------------------------------------------------------------------------

export interface LearnedItem {
  text: string;
  kind: MemoryKind | null;
}

/** At most this many facts are taken from one comment. */
export const LEARNED_MAX_PER_COMMENT = 5;

// "**Learned:** x", "Learned: x", "**Learned**:", "## Learned", "What I learned:" — never "Learned a lot today".
const LEARNED_LABEL = /^\s*(?:[-*•]\s+)?(?:#{1,6}\s*)?(?:\*\*|__)?\s*(?:what\s+(?:i|we)\s+)?learned\s*(?:\*\*|__)?\s*(?:[:\-–—]\s*(?:\*\*|__)?\s*(.*)|(?:\*\*|__)?\s*)$/i;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const OTHER_LABEL = /^\s*(?:#{1,6}\s+\S|(?:\*\*|__)[^*_]{1,40}(?:\*\*|__)\s*:?|[A-Z][A-Za-z ]{1,30}:\s*$)/;
const NOTHING = /^(?:none|nothing(?:\s+new)?|n\/?a|-|—|no(?:thing)?\s+(?:new\s+)?(?:lessons?|facts?)?)\.?$/i;
const KIND_PREFIX = /^(rule|warning|preference|lesson|fact)\s*[:\-–—]\s*/i;

function cleanItem(raw: string): LearnedItem | null {
  let text = raw
    .replace(/\*\*|__/g, "")
    .replace(/^\s*\[[ xX]\]\s*/, "")
    .trim();
  let kind: MemoryKind | null = null;
  const prefix = KIND_PREFIX.exec(text);
  if (prefix) {
    kind = prefix[1]!.toLowerCase() as MemoryKind;
    text = text.slice(prefix[0].length);
  }
  text = normalizeFactText(text);
  if (prefix && text) text = text.charAt(0).toUpperCase() + text.slice(1);
  if (!text || NOTHING.test(text)) return null;
  return { text, kind };
}

/**
 * Facts from a comment's **Learned:** section(s): the rest of the label line
 * and the bullets under it (wrapped lines join the bullet above). A new
 * heading or label ends the section. "Learned: none" gives nothing.
 */
export function parseLearned(body: string): LearnedItem[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const items: string[] = [];
  let inSection = false;
  let sawBlank = false;
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      if (inSection) inSection = false;
      continue;
    }
    if (inCode) continue;
    const label = LEARNED_LABEL.exec(line);
    if (label) {
      inSection = true;
      sawBlank = false;
      const rest = (label[1] ?? "").trim();
      if (rest) items.push(rest);
      continue;
    }
    if (!inSection) continue;
    if (!line.trim()) {
      sawBlank = true;
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      items.push(bullet[1]!);
      sawBlank = false;
      continue;
    }
    if (OTHER_LABEL.test(line) || sawBlank) {
      inSection = false;
      continue;
    }
    // A wrapped line continues the item above.
    if (items.length) items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
  }
  const out: LearnedItem[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const item = cleanItem(raw);
    if (!item) continue;
    const key = item.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= LEARNED_MAX_PER_COMMENT) break;
  }
  return out;
}

