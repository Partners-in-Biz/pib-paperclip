/**
 * Growth Lab rules for Social, pure and unit tested (no I/O).
 *
 * The loop (kit experiments.ts): score every published destination at 7
 * days (engagement per person reached, against the account's trailing
 * 30-day median), tag each post's features, test one variable at a time,
 * and turn wins and losses into playbook rules a person (or full autopilot)
 * keeps or discards.
 */
import {
  confidenceOf,
  engagementRate,
  experimentVerdict,
  featureLifts,
  lift,
  median,
  rankHypothesisTypes,
  RISK_THRESHOLDS,
  type JevAnswer,
  type JevQuestion,
  type JevQuestions,
  type Scoreboard,
  type Verdict,
  type VerdictResult,
} from "@partnersinbiz/pib-plugin-kit";

export const GROWTH_CHANNEL = "social";
export const DEFAULT_OBJECTIVE = "Raise engagement per person reached, 7 days after publishing, above each account's usual level.";
export const DEFAULT_METRIC = "engagement rate lift at 7d";
export const SCORE_WINDOW = "7d";
/** Trailing window for the account baseline. */
export const BASELINE_DAYS = 30;
/** Fewer earlier posts than this and a destination has no baseline (lift stays empty). */
export const BASELINE_MIN = 3;
export const MAX_RUNNING = 3;
export const MAX_PROPOSED = 3;
export const MAX_ACTIVE_QUESTIONS = 12;
/** An experiment is measured with what it has once this many days passed since it started. */
export const MEASURE_CUTOFF_DAYS = 21;
export const FEATURE_PURPOSE = "growth-post-features";
export const CAPTION_LIMIT = 1000;

export type Autopilot = "off" | "safe" | "full";
export const AUTOPILOT_MODES: Autopilot[] = ["off", "safe", "full"];

export class GrowthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrowthError";
  }
}

const DAY_MS = 24 * 3600_000;

// ── Scores ──────────────────────────────────────────────────────────────────

export interface MetricInput {
  destinationId: string;
  postId: string;
  accountId: string | null;
  platform: string | null;
  publishedAt: string | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  clicks?: number | null;
  reach?: number | null;
  impressions?: number | null;
  views?: number | null;
}

export interface DestinationScore {
  destinationId: string;
  postId: string;
  accountId: string | null;
  platform: string | null;
  publishedAt: string;
  engagementRate: number;
  basis: "reach" | "impressions" | "views";
  baselineMedian: number | null;
  baselineN: number;
  lift: number | null;
}

function positive(x: number | null | undefined): boolean {
  return typeof x === "number" && Number.isFinite(x) && x > 0;
}

/** Which audience number the rate divides by (kit engagementRate uses the same order). */
export function rateBasis(m: Pick<MetricInput, "reach" | "impressions" | "views">): DestinationScore["basis"] | null {
  if (positive(m.reach)) return "reach";
  if (positive(m.impressions)) return "impressions";
  if (positive(m.views)) return "views";
  return null;
}

/**
 * Score 7-day snapshots. Each destination is compared with the median rate of
 * the same account and platform over the 30 days before it published,
 * excluding the destination's own post. Snapshots without reach,
 * impressions or views are skipped (never scored as zero).
 */
export function scoreDestinations(rows: MetricInput[], options: { now?: Date; sinceDays?: number } = {}): DestinationScore[] {
  const now = (options.now ?? new Date()).getTime();
  const since = now - (options.sinceDays ?? 45) * DAY_MS;
  const rated = rows
    .map((row) => {
      const at = row.publishedAt ? Date.parse(row.publishedAt) : Number.NaN;
      const rate = engagementRate(row);
      const basis = rateBasis(row);
      return { row, at, rate, basis };
    })
    .filter((x) => Number.isFinite(x.at) && x.rate !== null && x.basis !== null) as Array<{ row: MetricInput; at: number; rate: number; basis: DestinationScore["basis"] }>;
  const groups = new Map<string, typeof rated>();
  for (const x of rated) {
    const key = `${x.row.accountId ?? ""}|${x.row.platform ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), x]);
  }
  const out: DestinationScore[] = [];
  for (const x of rated) {
    if (x.at < since) continue;
    const peers = groups.get(`${x.row.accountId ?? ""}|${x.row.platform ?? ""}`) ?? [];
    const baseline = peers
      .filter((p) => p.row.postId !== x.row.postId && p.at < x.at && p.at >= x.at - BASELINE_DAYS * DAY_MS)
      .map((p) => p.rate);
    const baselineMedian = baseline.length >= BASELINE_MIN ? median(baseline) : null;
    out.push({
      destinationId: x.row.destinationId,
      postId: x.row.postId,
      accountId: x.row.accountId,
      platform: x.row.platform,
      publishedAt: new Date(x.at).toISOString(),
      engagementRate: x.rate,
      basis: x.basis,
      baselineMedian,
      baselineN: baseline.length,
      lift: lift(x.rate, baselineMedian),
    });
  }
  return out;
}

/** One number per post: the median lift of its scored destinations. */
export function postLift(lifts: Array<number | null | undefined>): number | null {
  const values = lifts.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return values.length ? median(values) : null;
}

// ── Features ────────────────────────────────────────────────────────────────

export type FeatureType = "noul" | "choice" | "score";

/** A question the program adds (autoresearch-style feature discovery). */
export interface FeatureQuestion {
  key: string;
  type: FeatureType;
  question: string;
  /** choice: the options. */
  options?: string[];
  /** score: the levels, lowest first. */
  levels?: string[];
  status: "active" | "retired";
  proposedBy?: string | null;
  createdAt?: string;
  retiredAt?: string | null;
}

export const HOOK_OPTIONS: Record<string, string> = {
  question: "Opens with a question to the reader",
  bold_claim: "Opens with a bold, surprising or contrarian claim",
  story: "Opens with a personal story, moment or anecdote",
  stat: "Opens with a number, statistic or result",
  how_to: "Opens by promising steps, tips or a how-to",
  offer: "Opens with an offer, promotion, launch or announcement",
};

export const TONE_LEVELS = ["formal", "professional", "conversational", "casual", "playful"];
const TONE_CRITERIA = [
  "Formal and corporate",
  "Professional and polished",
  "Conversational",
  "Casual and friendly",
  "Playful, witty or funny",
];

/** Feature keys computed in code (never sent to Jev). */
export const CODE_FEATURES = ["format", "length", "daypart"] as const;
/** Default Jev feature keys (topic only when the program lists topics). */
export const DEFAULT_JEV_FEATURES = ["hook", "cta", "topic", "tone"] as const;
export const RESERVED_KEYS = new Set<string>([...CODE_FEATURES, ...DEFAULT_JEV_FEATURES]);

export interface ProgramFeatureContext {
  topics: string[];
  featureQuestions: FeatureQuestion[];
}

export function activeQuestions(questions: FeatureQuestion[]): FeatureQuestion[] {
  return questions.filter((q) => q.status === "active");
}

/** Every Jev feature key this program tags. */
export function jevFeatureKeys(program: ProgramFeatureContext): string[] {
  const keys: string[] = ["hook", "cta", "tone"];
  if (program.topics.length) keys.splice(2, 0, "topic");
  for (const q of activeQuestions(program.featureQuestions)) keys.push(q.key);
  return keys;
}

function customQuestion(q: FeatureQuestion): JevQuestion {
  if (q.type === "noul") return { type: "noul", instructions: q.question };
  if (q.type === "choice") return { type: "choice", instructions: q.question, criteria: Object.fromEntries((q.options ?? []).map((o) => [o, null])) };
  return { type: "score", instructions: q.question, criteria: q.levels ?? [] };
}

/** The Jev questions for one post (only `keys`, e.g. the ones it is missing). */
export function featureQuestionsFor(program: ProgramFeatureContext, keys: string[]): JevQuestions {
  const wanted = new Set(keys);
  const out: JevQuestions = {};
  if (wanted.has("hook")) {
    out.hook = { type: "choice", instructions: "How does this social media post open (its first line or two)?", criteria: { ...HOOK_OPTIONS } };
  }
  if (wanted.has("cta")) {
    out.cta = {
      type: "noul",
      instructions: "Does the post ask the reader to do something (comment, reply, click a link, book, buy, sign up, share or save)?",
      criteria: { true: "It clearly asks for an action", false: "It asks for nothing" },
    };
  }
  if (wanted.has("topic") && program.topics.length) {
    const criteria: Record<string, null | string> = {};
    for (const topic of program.topics) criteria[topic] = null;
    criteria.other = "None of the listed topics";
    out.topic = { type: "choice", instructions: "Which topic is this post mainly about?", criteria };
  }
  if (wanted.has("tone")) {
    out.tone = { type: "score", instructions: "How formal or playful is the tone of this post?", criteria: [...TONE_CRITERIA] };
  }
  for (const q of activeQuestions(program.featureQuestions)) {
    if (wanted.has(q.key)) out[q.key] = customQuestion(q);
  }
  return out;
}

export interface FeatureValue {
  key: string;
  value: string | null;
  confidence: number;
  source: "code" | "jev";
  decisionId?: string | null;
}

function levelLabel(score: number, labels: string[]): string | null {
  if (!labels.length || !Number.isFinite(score)) return null;
  return labels[Math.min(labels.length - 1, Math.max(0, Math.round(score)))] ?? null;
}

/** Turn Jev answers into stored feature values. */
export function featureValuesFrom(program: ProgramFeatureContext, answers: Record<string, JevAnswer>, ids: Record<string, string> = {}): FeatureValue[] {
  const custom = new Map(program.featureQuestions.map((q) => [q.key, q]));
  const out: FeatureValue[] = [];
  for (const [key, answer] of Object.entries(answers)) {
    let value: string | null = null;
    if (answer.type === "noul") value = answer.noul >= 0.5 ? "yes" : "no";
    else if (answer.type === "choice") value = answer.choice;
    else if (answer.type === "score") value = levelLabel(answer.score, key === "tone" ? TONE_LEVELS : custom.get(key)?.levels ?? []);
    out.push({ key, value, confidence: Math.round(confidenceOf(answer) * 1000) / 1000, source: "jev", decisionId: ids[key] ?? null });
  }
  return out;
}

export interface PostForFeatures {
  body: string;
  media: Array<{ kind: string }>;
  publishedAt: string | null;
}

export function formatOf(media: Array<{ kind: string }>): string {
  if (media.some((m) => m.kind === "video")) return "video";
  if (media.length > 1) return "carousel";
  if (media.length === 1) return "image";
  return "text";
}

export function lengthBucket(text: string): string {
  const n = Array.from(text.trim()).length;
  if (n < 100) return "short";
  if (n < 300) return "medium";
  return "long";
}

/** Hour of day in the company's timezone. */
export function localHour(iso: string, timeZone: string): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const hour = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(date);
    const n = Number(hour);
    return Number.isInteger(n) ? n % 24 : null;
  } catch {
    return date.getUTCHours();
  }
}

export function daypart(hour: number): string {
  if (hour >= 6 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return "night";
}

/** Format, length bucket and posting daypart, computed here (never sent to Jev). */
export function codeFeatures(post: PostForFeatures, timeZone: string): FeatureValue[] {
  const out: FeatureValue[] = [
    { key: "format", value: formatOf(post.media), confidence: 1, source: "code" },
    { key: "length", value: lengthBucket(post.body), confidence: 1, source: "code" },
  ];
  const hour = post.publishedAt ? localHour(post.publishedAt, timeZone) : null;
  if (hour !== null) out.push({ key: "daypart", value: daypart(hour), confidence: 1, source: "code" });
  return out;
}

/** What Jev sees for a post: the caption text and nothing else. */
export function captionState(body: string): string {
  const chars = Array.from(body.trim());
  return chars.length <= CAPTION_LIMIT ? chars.join("") : chars.slice(0, CAPTION_LIMIT).join("");
}

/** Feature values confident enough to aggregate (code features always are). */
export function usableFeatures(values: Array<{ key: string; value: string | null; confidence: number }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    if (v.value === null || v.value === "") continue;
    if (v.confidence < RISK_THRESHOLDS.read) continue;
    out[v.key] = v.value;
  }
  return out;
}

// ── Feature questions (discovery) ───────────────────────────────────────────

const KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;

/** Validate a proposed question; returns the stored shape. */
export function normalizeFeatureQuestion(input: Record<string, unknown>, existing: FeatureQuestion[], by: string | null, now = new Date()): FeatureQuestion {
  const key = typeof input.key === "string" ? input.key.trim().toLowerCase() : "";
  if (!KEY_RE.test(key)) throw new GrowthError("key must be 2-32 lowercase letters, digits or underscores, starting with a letter (e.g. emoji_use)");
  if (RESERVED_KEYS.has(key)) throw new GrowthError(`${key} is a built-in feature; pick another key`);
  if (existing.some((q) => q.key === key && q.status === "active")) throw new GrowthError(`The program already asks ${key}`);
  if (existing.some((q) => q.key === key)) throw new GrowthError(`${key} was used before; pick a new key so old answers are not mixed in`);
  if (activeQuestions(existing).length >= MAX_ACTIVE_QUESTIONS) throw new GrowthError(`A program asks at most ${MAX_ACTIVE_QUESTIONS} questions of its own. Retire one first.`);
  const type = input.type;
  if (type !== "noul" && type !== "choice" && type !== "score") throw new GrowthError("type must be noul (yes/no), choice or score");
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (question.length < 8 || question.length > 500) throw new GrowthError("question must be 8-500 characters and answerable from the caption alone");
  const list = (value: unknown, name: string, min: number, max: number): string[] => {
    if (!Array.isArray(value)) throw new GrowthError(`${name} must be a list of ${min}-${max} short strings`);
    const items = Array.from(new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean)));
    if (items.length < min || items.length > max || items.some((v) => v.length > 80)) throw new GrowthError(`${name} must be a list of ${min}-${max} short strings (80 characters each at most)`);
    return items;
  };
  const out: FeatureQuestion = { key, type, question, status: "active", proposedBy: by, createdAt: now.toISOString(), retiredAt: null };
  if (type === "choice") out.options = list(input.options, "options", 2, 20);
  if (type === "score") out.levels = list(input.levels, "levels", 2, 10);
  return out;
}

// ── Hypotheses ──────────────────────────────────────────────────────────────

const TYPE_RE = /^[a-z][a-z0-9_]{0,31}:[a-z0-9][a-z0-9_-]{0,63}$/;

export function slug(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "x";
}

/** The hypothesis types the loop considers (feature:value), plus any already on the scoreboard. */
export function hypothesisCandidates(program: ProgramFeatureContext & { scoreboard: Scoreboard }): string[] {
  const types = new Set<string>();
  for (const option of Object.keys(HOOK_OPTIONS)) types.add(`hook:${option}`);
  types.add("cta:yes");
  for (const format of ["video", "carousel", "image", "text"]) types.add(`format:${format}`);
  types.add("length:short");
  types.add("length:long");
  for (const part of ["morning", "afternoon", "evening"]) types.add(`daypart:${part}`);
  types.add("tone:playful");
  types.add("tone:formal");
  for (const topic of program.topics) types.add(`topic:${slug(topic)}`);
  for (const q of activeQuestions(program.featureQuestions)) {
    if (q.type === "noul") types.add(`${q.key}:yes`);
    for (const option of q.options ?? []) types.add(`${q.key}:${slug(option)}`);
    if (q.type === "score" && q.levels?.length) types.add(`${q.key}:${slug(q.levels[q.levels.length - 1]!)}`);
  }
  for (const key of Object.keys(program.scoreboard ?? {})) types.add(key);
  return [...types];
}

export interface RankedType {
  type: string;
  tries: number;
  /** UCB score; null for types never tried (they rank first). */
  score: number | null;
  untried: boolean;
  running: boolean;
  /** What the posts already say: median lift of posts with this feature value. */
  observedLift: number | null;
  observedPosts: number;
}

/** UCB ranking (kit rankHypothesisTypes) with what the posts already show. */
export function rankedHypotheses(
  program: ProgramFeatureContext & { scoreboard: Scoreboard },
  context: { running: string[]; lifts: Array<{ key: string; count: number; medianLift: number }> },
  limit = 12,
): RankedType[] {
  const running = new Set(context.running);
  const observed = new Map(context.lifts.map((l) => [l.key, l]));
  return rankHypothesisTypes(program.scoreboard ?? {}, hypothesisCandidates(program))
    .map((r) => {
      const [feature, value] = r.type.split(":");
      const seen = observed.get(`${feature}=${value}`);
      return {
        type: r.type,
        tries: r.tries,
        score: Number.isFinite(r.score) ? Math.round(r.score * 1000) / 1000 : null,
        untried: !Number.isFinite(r.score),
        running: running.has(r.type),
        observedLift: seen ? Math.round(seen.medianLift * 1000) / 1000 : null,
        observedPosts: seen?.count ?? 0,
      };
    })
    .slice(0, Math.max(limit, 1));
}

export interface ArmSpec {
  key: "control" | "variant";
  description: string;
}

export interface ProposalInput {
  hypothesis: string;
  hypothesisType: string;
  variable: string;
  arms: ArmSpec[];
  minPerArm: number;
  windowDays: number;
}

function text(value: unknown, name: string, min: number, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length < min || s.length > max) throw new GrowthError(`${name} must be ${min}-${max} characters`);
  return s;
}

/** Arms as a list [{key, description}] or an object {control, variant}. */
export function normalizeArms(value: unknown): ArmSpec[] {
  let entries: Array<[string, unknown]> = [];
  if (Array.isArray(value)) {
    entries = value.map((a) => (a && typeof a === "object" ? [String((a as Record<string, unknown>).key ?? ""), (a as Record<string, unknown>).description] : ["", null]));
  } else if (value && typeof value === "object") {
    entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, v && typeof v === "object" ? (v as Record<string, unknown>).description : v]);
  }
  const byKey = new Map(entries.map(([k, v]) => [k.trim().toLowerCase(), v]));
  if (byKey.size !== 2 || !byKey.has("control") || !byKey.has("variant")) {
    throw new GrowthError('arms must be exactly two: control (what we do now) and variant (the change), e.g. [{"key":"control","description":"Statement hook"},{"key":"variant","description":"Question hook"}]');
  }
  return [
    { key: "control", description: text(byKey.get("control"), "arms.control description", 3, 300) },
    { key: "variant", description: text(byKey.get("variant"), "arms.variant description", 3, 300) },
  ];
}

export function normalizeProposal(input: Record<string, unknown>): ProposalInput {
  const hypothesisType = typeof input.hypothesisType === "string" ? input.hypothesisType.trim().toLowerCase() : "";
  if (!TYPE_RE.test(hypothesisType)) throw new GrowthError('hypothesisType must look like feature:value, e.g. "hook:question" or "format:video" (see the ranked types in performance-review)');
  const minPerArm = input.minPerArm == null ? 3 : Number(input.minPerArm);
  if (!Number.isInteger(minPerArm) || minPerArm < 2 || minPerArm > 20) throw new GrowthError("minPerArm must be a whole number from 2 to 20 (default 3)");
  const windowDays = input.windowDays == null ? 7 : Number(input.windowDays);
  if (windowDays !== 7) throw new GrowthError("windowDays is 7: posts are scored on their 7-day numbers");
  return {
    hypothesis: text(input.hypothesis, "hypothesis", 10, 500),
    hypothesisType,
    variable: text(input.variable, "variable", 2, 200),
    arms: normalizeArms(input.arms),
    minPerArm,
    windowDays,
  };
}

/** Why a new proposal is refused, or null. */
export function proposalBlocker(input: { autopilot: Autopilot; running: number; proposed: number; openTypes: string[]; hypothesisType: string }): string | null {
  if (input.autopilot === "off") return "Growth autopilot is off for this program, so agents do not propose experiments. A person can switch it to safe on the Growth tab.";
  if (input.running >= MAX_RUNNING) return `This program already runs ${MAX_RUNNING} experiments. Wait for one to be measured (or ask a person to abandon one).`;
  if (input.proposed >= MAX_PROPOSED) return `${MAX_PROPOSED} proposals are already waiting for approval. Wait until a person decides them.`;
  if (input.openTypes.includes(input.hypothesisType)) return `An experiment for ${input.hypothesisType} is already proposed or running.`;
  return null;
}

// ── Measuring ───────────────────────────────────────────────────────────────

export interface ItemState {
  postId: string;
  arm: string;
  published: boolean;
  value: number | null;
}

export function readiness(
  experiment: { minPerArm: number; startedAt: string | null },
  items: ItemState[],
  now = new Date(),
): { ready: boolean; reason: string } {
  const started = experiment.startedAt ? Date.parse(experiment.startedAt) : Number.NaN;
  const cutoff = Number.isFinite(started) && now.getTime() >= started + MEASURE_CUTOFF_DAYS * DAY_MS;
  const counts = (arm: string) => items.filter((i) => i.arm === arm && i.value !== null).length;
  const complete = items.length > 0 && items.every((i) => i.published && i.value !== null) && counts("control") >= experiment.minPerArm && counts("variant") >= experiment.minPerArm;
  if (complete) return { ready: true, reason: "Every tagged post has its 7-day score." };
  if (cutoff) return { ready: true, reason: `${MEASURE_CUTOFF_DAYS} days have passed since it started; measured with the posts that have scores.` };
  return { ready: false, reason: `Waiting: control ${counts("control")}/${experiment.minPerArm}, variant ${counts("variant")}/${experiment.minPerArm} scored posts.` };
}

export interface MeasureOutcome extends VerdictResult {
  control: number[];
  variant: number[];
  items: number;
  why: string;
}

/**
 * Verdict on the arms' lifts. Lifts are compared as ratios to the account's
 * usual level (1 + lift), so "+50%" means the variant posts did 50% better
 * than the control posts after both were normalised per account. The medians
 * reported back are lifts again.
 */
export function measureArms(experiment: { minPerArm: number }, items: ItemState[], why: string): MeasureOutcome {
  const values = (arm: string) => items.filter((i) => i.arm === arm && i.value !== null).map((i) => i.value!);
  const control = values("control");
  const variant = values("variant");
  const result = experimentVerdict({ control: control.map((v) => 1 + v), variant: variant.map((v) => 1 + v), minPerArm: experiment.minPerArm });
  const back = (x: number | null) => (x === null ? null : Math.round((x - 1) * 10_000) / 10_000);
  return { ...result, controlMedian: back(result.controlMedian), variantMedian: back(result.variantMedian), control, variant, items: items.length, why };
}

function pct(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return "n/a";
  return `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
}

export type PlaybookSection = "goal" | "rules" | "avoid" | "open" | "constraints";
export const SECTION_HEADINGS: Record<PlaybookSection, string> = {
  goal: "Goal",
  rules: "Rules we follow",
  avoid: "Things that did not work",
  open: "Open questions to test",
  constraints: "Constraints",
};

export interface ChangeSpec {
  op: "add" | "remove" | "replace";
  section: PlaybookSection | null;
  body: string;
}

/** The rule a won or lost experiment adds to the playbook, or null for no change / inconclusive. */
export function playbookChangeFor(
  experiment: { hypothesisType: string; arms: ArmSpec[] },
  outcome: Pick<MeasureOutcome, "verdict" | "relativeChange" | "control" | "variant">,
  on: string,
): ChangeSpec | null {
  const control = experiment.arms.find((a) => a.key === "control")?.description ?? "control";
  const variant = experiment.arms.find((a) => a.key === "variant")?.description ?? "variant";
  const evidence = `${experiment.hypothesisType}, ${outcome.variant.length} vs ${outcome.control.length} posts, measured ${on}`;
  if (outcome.verdict === "win") {
    return { op: "add", section: "rules", body: `${variant} (beat "${control}" by ${pct(outcome.relativeChange)} median lift; ${evidence})` };
  }
  if (outcome.verdict === "loss") {
    return { op: "add", section: "avoid", body: `${variant} (did ${pct(outcome.relativeChange)} vs "${control}"; ${evidence})` };
  }
  return null;
}

export function autoKeep(autopilot: Autopilot, verdict: Verdict): boolean {
  return autopilot === "full" && verdict === "win";
}

/** Agents approve experiments and decide playbook changes only on full autopilot. */
export function agentMayDecide(autopilot: Autopilot): boolean {
  return autopilot === "full";
}

// ── Playbook edits ──────────────────────────────────────────────────────────

const NONE_YET = /^-\s*\(none yet\)\s*$/i;

export function isSection(value: unknown): value is PlaybookSection {
  return typeof value === "string" && value in SECTION_HEADINGS;
}

function headingIndex(lines: string[], heading: string): number {
  const want = heading.toLowerCase();
  return lines.findIndex((line) => /^##\s+/.test(line) && line.replace(/^##\s+/, "").trim().toLowerCase().startsWith(want));
}

function sectionEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i += 1) if (/^#{1,2}\s+/.test(lines[i]!)) return i;
  return lines.length;
}

function bullet(text: string): string {
  return `- ${text.replace(/^\s*-\s*/, "").replace(/\s+/g, " ").trim()}`;
}

/** Apply a change to the playbook markdown. Throws when a removal does not match. */
export function applyPlaybookChange(playbook: string, change: ChangeSpec): string {
  if (change.op === "replace") {
    const next = change.body.trim();
    if (!next) throw new GrowthError("The new playbook is empty");
    return `${next}\n`;
  }
  const lines = playbook.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const line = bullet(change.body);
  if (change.op === "add") {
    const heading = SECTION_HEADINGS[change.section ?? "rules"];
    let at = headingIndex(lines, heading);
    if (at < 0) {
      lines.push("", `## ${heading}`);
      at = lines.length - 1;
    }
    const end = sectionEnd(lines, at);
    const body = lines.slice(at + 1, end).filter((l) => !NONE_YET.test(l.trim()));
    if (body.some((l) => l.trim().toLowerCase() === line.toLowerCase())) return `${lines.join("\n")}\n`;
    while (body.length && !body[body.length - 1]!.trim()) body.pop();
    const next = [...lines.slice(0, at + 1), ...body, line, ...(end < lines.length ? [""] : []), ...lines.slice(end)];
    return `${next.join("\n")}\n`;
  }
  const target = line.toLowerCase().replace(/\.$/, "");
  const index = lines.findIndex((l) => /^\s*-\s+/.test(l) && bullet(l).toLowerCase().replace(/\.$/, "") === target);
  if (index < 0) throw new GrowthError(`The playbook has no line "${line}". Use get-playbook and copy the line exactly.`);
  lines.splice(index, 1);
  // Keep an empty section readable.
  let head = index - 1;
  while (head >= 0 && !/^##\s+/.test(lines[head]!)) head -= 1;
  if (head >= 0) {
    const end = sectionEnd(lines, head);
    if (!lines.slice(head + 1, end).some((l) => /^\s*-\s+/.test(l))) lines.splice(head + 1, 0, "- (none yet)");
  }
  return `${lines.join("\n")}\n`;
}

export function changeDiff(change: ChangeSpec, playbook?: string): string {
  if (change.op === "replace") {
    const before = playbook ? playbook.split("\n").length : 0;
    return `Replace the whole playbook (${before} → ${change.body.trim().split("\n").length} lines)`;
  }
  const heading = change.op === "add" ? SECTION_HEADINGS[change.section ?? "rules"] : "playbook";
  return `${change.op === "add" ? "+" : "−"} ${heading}: ${bullet(change.body)}`;
}

export function normalizeChange(input: Record<string, unknown>): ChangeSpec {
  const op = input.op ?? "add";
  if (op !== "add" && op !== "remove" && op !== "replace") throw new GrowthError("op must be add, remove or replace");
  if (op === "replace") return { op, section: null, body: text(input.playbook ?? input.text, "playbook", 20, 20_000) };
  const section = input.section == null ? (op === "add" ? "rules" : null) : input.section;
  if (op === "add" && !isSection(section)) throw new GrowthError(`section must be one of ${Object.keys(SECTION_HEADINGS).join(", ")}`);
  return { op, section: op === "add" ? (section as PlaybookSection) : null, body: text(input.text, "text", 3, 400) };
}

// ── Review ──────────────────────────────────────────────────────────────────

export interface ScoredPostRow {
  postId: string;
  body: string;
  platform: string | null;
  accountId: string | null;
  publishedAt: string | null;
  engagementRate: number;
  lift: number | null;
  experimentId: string | null;
  experimentArm: string | null;
}

export interface ReviewPost {
  postId: string;
  caption: string;
  platforms: string[];
  publishedAt: string | null;
  lift: number | null;
  engagementRate: number | null;
  destinations: number;
  features: Record<string, string>;
  experimentId: string | null;
  arm: string | null;
}

/** One row per post (median across its destinations), best first. */
export function reviewPosts(rows: ScoredPostRow[], features: Map<string, Record<string, string>>): ReviewPost[] {
  const byPost = new Map<string, ScoredPostRow[]>();
  for (const row of rows) byPost.set(row.postId, [...(byPost.get(row.postId) ?? []), row]);
  const out: ReviewPost[] = [];
  for (const [postId, list] of byPost) {
    const first = list[0]!;
    const caption = Array.from(first.body.trim());
    out.push({
      postId,
      caption: caption.length > 200 ? `${caption.slice(0, 200).join("")}…` : caption.join(""),
      platforms: Array.from(new Set(list.map((r) => r.platform).filter((p): p is string => Boolean(p)))),
      publishedAt: list.map((r) => r.publishedAt).filter(Boolean).sort()[0] ?? null,
      lift: postLift(list.map((r) => r.lift)),
      engagementRate: median(list.map((r) => r.engagementRate)),
      destinations: list.length,
      features: features.get(postId) ?? {},
      experimentId: first.experimentId,
      arm: first.experimentArm,
    });
  }
  return out.sort((a, b) => (b.lift ?? Number.NEGATIVE_INFINITY) - (a.lift ?? Number.NEGATIVE_INFINITY));
}

export function topAndBottom(posts: ReviewPost[], n = 5): { top: ReviewPost[]; bottom: ReviewPost[] } {
  const withLift = posts.filter((p) => p.lift !== null);
  const top = withLift.slice(0, n);
  const rest = withLift.slice(top.length);
  return { top, bottom: rest.slice(-n).reverse() };
}

export function liftsByFeature(posts: ReviewPost[], minCount = 3) {
  return featureLifts(posts.map((p) => ({ lift: p.lift, features: p.features })), minCount).map((row) => ({
    key: row.key,
    count: row.count,
    medianLift: Math.round(row.medianLift * 1000) / 1000,
  }));
}

// ── Time ────────────────────────────────────────────────────────────────────

/** Calendar date (YYYY-MM-DD) in the company's timezone. */
export function localDate(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** ISO week label, e.g. 2026-W40, in the company's timezone. */
export function isoWeek(date: Date, timeZone: string): string {
  const [y, m, d] = localDate(date, timeZone).split("-").map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, m - 1, d));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((day.getTime() - yearStart.getTime()) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function addDaysIso(date: Date, days: number): string {
  return new Date(date.getTime() + days * DAY_MS).toISOString();
}
