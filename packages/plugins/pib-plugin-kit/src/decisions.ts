/**
 * Typed decisions with Jev (TypeSafe's System One model).
 *
 * Jev reads a `state` (text or JSON) and answers typed questions: `noul`
 * (probability yes), `choice` (one of your options, with a distribution) and
 * `score` (a level on your rubric). It never writes text. Everything goes in
 * one call per item; the state is sent once.
 *
 * Rules we keep (see wiki `jev-laya-decision-models`):
 * - Send only the fields a decision needs, never whole documents.
 * - Deterministic code keeps authority: Jev labels, routes and ranks; money
 *   moves and destructive actions still need a person or an approval.
 * - Act only above a threshold that rises with the stakes (`shouldAct`).
 * - Log every decision so people can correct it; corrections become labelled
 *   data (for a future self-hosted Laya).
 * - With no API key configured, `decide` returns null and callers fall back.
 *
 * API: POST https://api.typesafe.ai/v1/systemone (docs.typesafe.ai/api).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { secretField, SecretResolver } from "./config.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
/** Pinned so thresholds tuned on one version do not drift when the alias moves. */
export const JEV_MODEL_DEFAULT = "jev-1.13.0";

type Rubric = string | Record<string, unknown> | unknown[];

export type JevQuestion =
  | { type: "noul"; instructions: Rubric; criteria?: { true?: Rubric; false?: Rubric } }
  | { type: "choice"; instructions: Rubric; criteria: Record<string, Rubric | null> }
  | { type: "score"; instructions: Rubric; criteria: Rubric[] };

export type JevQuestions = Record<string, JevQuestion>;

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend?: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface DecisionClientConfig {
  apiKey: string;
  model?: string;
  endpoint?: string;
  timeoutMs?: number;
}

export class JevError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
    this.name = "JevError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One Jev call with retries on 429/529/5xx and network errors (exponential backoff, honours retry-after). */
export async function jevEvaluate(
  config: DecisionClientConfig,
  state: unknown,
  questions: JevQuestions,
  options: { fetchImpl?: typeof fetch; maxRetries?: number } = {},
): Promise<JevResponse> {
  if (Object.keys(questions).length === 0) throw new JevError("No questions to ask", null, false);
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRetries = options.maxRetries ?? 3;
  const body = JSON.stringify({ state, model: config.model || JEV_MODEL_DEFAULT, questions });
  let lastError: JevError | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000);
    try {
      const res = await fetchImpl(config.endpoint || JEV_ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
        body,
        signal: controller.signal,
      });
      if (res.ok) return (await res.json()) as JevResponse;
      const text = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      lastError = new JevError(`Jev returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`, res.status, retryable);
      if (!retryable) throw lastError;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20_000) : 500 * 2 ** attempt);
    } catch (error) {
      if (error instanceof JevError && !error.retryable) throw error;
      lastError = error instanceof JevError ? error : new JevError(error instanceof Error ? error.message : String(error), null, true);
      if (attempt < maxRetries) await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new JevError("Jev call failed", null, true);
}

// ---------------------------------------------------------------------------
// Reading answers
// ---------------------------------------------------------------------------

/** How sure the answer is, 0–1. For noul: distance from 0.5, doubled (0.5 → 0, 0.95 → 0.9). */
export function confidenceOf(answer: JevAnswer | undefined | null): number {
  if (!answer) return 0;
  if (answer.type === "noul") return Math.min(1, Math.abs(answer.noul - 0.5) * 2);
  return typeof answer.confidence === "number" ? answer.confidence : 0;
}

/** The answer as a plain value: probability (noul), option (choice), level mean (score). */
export function valueOf(answer: JevAnswer | undefined | null): number | string | null {
  if (!answer) return null;
  if (answer.type === "noul") return answer.noul;
  if (answer.type === "choice") return answer.choice;
  return answer.score;
}

/** Stakes → minimum confidence before code acts on its own. Below it, a person or agent looks. */
export const RISK_THRESHOLDS = {
  read: 0.5,
  update: 0.7,
  money: 0.8,
  destructive: 0.9,
} as const;
export type DecisionRisk = keyof typeof RISK_THRESHOLDS;

/** True when the answer is confident enough to act on at this risk level. */
export function shouldAct(answer: JevAnswer | undefined | null, risk: DecisionRisk): boolean {
  return confidenceOf(answer) >= RISK_THRESHOLDS[risk];
}

/** For noul questions: yes only when confident (p ≥ 0.5 + threshold/2). */
export function isYes(answer: JevAnswer | undefined | null, risk: DecisionRisk = "read"): boolean {
  return Boolean(answer && answer.type === "noul" && answer.noul >= 0.5 && shouldAct(answer, risk));
}

// ---------------------------------------------------------------------------
// Config and logging
// ---------------------------------------------------------------------------

/** Settings block each plugin adds as `jev` in its instanceConfigSchema. */
export function jevConfigSchema() {
  return {
    type: "object",
    title: "Smart sorting (Jev by TypeSafe)",
    description:
      "Optional smarter sorting and routing (triage, categories, lead scoring) with TypeSafe's Jev. Pick the same Paperclip secret in every PiB plugin. Leave it empty and the built-in rules are used.",
    properties: {
      apiKey: secretField("TypeSafe API key", "From typesafe.ai → API keys. Stored as a Paperclip secret."),
      model: { type: "string", title: "Model", default: JEV_MODEL_DEFAULT, description: "Pinned version, e.g. jev-1.13.0. Change it on purpose; thresholds are tuned per version." },
      enabled: { type: "boolean", title: "Use smart sorting", default: true },
    },
  } as const;
}

/** Resolves the Jev settings for a company, or null when no key is set or it is switched off. */
export async function decisionConfig(resolver: SecretResolver, config: Record<string, unknown> | null | undefined): Promise<DecisionClientConfig | null> {
  const jev = (config?.jev ?? null) as { enabled?: boolean; model?: string } | null;
  if (jev?.enabled === false) return null;
  const apiKey = await resolver.get("jev.apiKey");
  if (!apiKey) return null;
  return { apiKey, model: typeof jev?.model === "string" && jev.model.trim() ? jev.model.trim() : JEV_MODEL_DEFAULT };
}

export function decisionsMigration(ns: string): string {
  return `CREATE TABLE ${ns}.decisions (
  id text PRIMARY KEY,
  company_id text NOT NULL,
  purpose text NOT NULL,
  subject_kind text NOT NULL,
  subject_id text NOT NULL,
  question_key text NOT NULL,
  answer_type text NOT NULL,
  value_text text,
  value_num numeric,
  confidence numeric NOT NULL,
  probabilities jsonb,
  model text NOT NULL,
  acted boolean NOT NULL DEFAULT false,
  corrected_to text,
  corrected_by text,
  corrected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_subject ON ${ns}.decisions (company_id, subject_kind, subject_id);
CREATE INDEX decisions_purpose ON ${ns}.decisions (company_id, purpose, created_at);
`;
}

export interface DecisionResult {
  model: string;
  answers: Record<string, JevAnswer>;
  inputTokens: number;
  /** Decision row ids by question key (when logged). */
  ids: Record<string, string>;
}

export interface DecideInput {
  config: DecisionClientConfig | null;
  purpose: string;
  subject: { kind: string; id: string };
  state: unknown;
  questions: JevQuestions;
  /** Question keys the caller will act on without review (marks `acted`). */
  acting?: string[];
  log?: boolean;
  fetchImpl?: typeof fetch;
}

function ns(ctx: PluginContext): string {
  const name = ctx.db.namespace;
  if (!/^plugin_[a-z0-9_]+$/.test(name)) throw new Error("Unsafe namespace");
  return name;
}

/** Writes one `decisions` row per answer; returns the row ids by question key. A failed write is logged and skipped. */
async function logAnswers(
  ctx: PluginContext,
  companyId: string,
  input: { config: DecisionClientConfig; purpose: string; subject: { kind: string; id: string }; acting?: string[]; log?: boolean },
  answers: Record<string, JevAnswer>,
  model: string | undefined,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  if (input.log === false) return ids;
  for (const [key, answer] of Object.entries(answers)) {
    const id = crypto.randomUUID();
    const value = valueOf(answer);
    try {
      await ctx.db.execute(
        `INSERT INTO ${ns(ctx)}.decisions (id, company_id, purpose, subject_kind, subject_id, question_key, answer_type, value_text, value_num, confidence, probabilities, model, acted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
        [
          id,
          companyId,
          input.purpose,
          input.subject.kind,
          input.subject.id,
          key,
          answer.type,
          typeof value === "string" ? value : null,
          typeof value === "number" ? value : null,
          confidenceOf(answer),
          answer.type === "noul" ? null : JSON.stringify(answer.probabilities ?? {}),
          model ?? input.config.model ?? JEV_MODEL_DEFAULT,
          Boolean(input.acting?.includes(key)),
        ],
      );
      ids[key] = id;
    } catch (error) {
      ctx.logger.info("Decision log write failed", { key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return ids;
}

/**
 * Ask Jev and log the answers. Returns null when Jev is not configured or the
 * call fails (the failure is logged; callers fall back to their rules).
 */
export async function decide(ctx: PluginContext, companyId: string, input: DecideInput): Promise<DecisionResult | null> {
  if (!input.config) return null;
  let response: JevResponse;
  try {
    response = await jevEvaluate(input.config, input.state, input.questions, { fetchImpl: input.fetchImpl });
  } catch (error) {
    ctx.logger.warn("Jev decision failed; falling back", { purpose: input.purpose, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
  const ids = await logAnswers(ctx, companyId, { ...input, config: input.config }, response.answers ?? {}, response.model);
  return { model: response.model, answers: response.answers ?? {}, inputTokens: response.usage?.input_tokens ?? 0, ids };
}

/** Items per Jev request, and the most characters of state one request carries (Jev reads about 32k tokens). */
export const BATCH_MAX_ITEMS = 25;
export const BATCH_MAX_CHARS = 60_000;

export interface DecideBatchInput<T> {
  config: DecisionClientConfig | null;
  purpose: string;
  subjectKind: string;
  items: T[];
  /** A stable id per item: the subject id in the decision log, and how the answers find their way back. */
  idOf: (item: T) => string;
  /** What Jev reads about one item (only the fields the decision needs). */
  stateOf: (item: T) => unknown;
  /** The same questions asked of every item. Keys are returned per item exactly as written here. */
  questions: JevQuestions;
  /** Shared by every item and sent once per request instead of once per item (the rules, the site name, the rubric context). */
  context?: unknown;
  acting?: string[];
  maxItems?: number;
  maxChars?: number;
  log?: boolean;
  fetchImpl?: typeof fetch;
}

/** Splits items into requests: at most `maxItems` and `maxChars` of state each. An item that is too big alone still goes alone. */
export function chunkForBatch<T>(items: T[], stateChars: (item: T) => number, maxItems = BATCH_MAX_ITEMS, maxChars = BATCH_MAX_CHARS): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const item of items) {
    const n = stateChars(item);
    if (current.length > 0 && (current.length >= maxItems || size + n > maxChars)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += n;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Judge many items in one pass: one Jev request per chunk of items instead of one per item. The shared context is sent once,
 * each item's state once, and every item gets the same questions under its own names. Answers come back split per item
 * and are logged per item, exactly as `decide` would. The result lines up with `items`; an item is null when Jev is not
 * configured or its request failed after the single-item retry, so callers fall back to their rules as they do today.
 *
 * Questions about one item must not depend on another item (ranking, "better than #40"): those run afterwards on the
 * scored set, in a second stage the caller owns.
 */
export async function decideBatch<T>(ctx: PluginContext, companyId: string, input: DecideBatchInput<T>): Promise<Array<DecisionResult | null>> {
  const out: Array<DecisionResult | null> = new Array(input.items.length).fill(null);
  const config = input.config;
  if (!config || input.items.length === 0) return out;
  const index = new Map<T, number>(input.items.map((item, i) => [item, i]));
  const states = new Map<T, unknown>(input.items.map((item) => [item, input.stateOf(item)]));
  const chunks = chunkForBatch(input.items, (item) => JSON.stringify(states.get(item) ?? "").length + 80, input.maxItems, input.maxChars);

  for (const chunk of chunks) {
    const state: Record<string, unknown> = { items: Object.fromEntries(chunk.map((item) => [input.idOf(item), states.get(item)])) };
    if (input.context !== undefined) state.context = input.context;
    const questions: JevQuestions = {};
    const names = new Map<string, { item: T; key: string }>();
    chunk.forEach((item, n) => {
      for (const [key, question] of Object.entries(input.questions)) {
        const name = `${key}__${n}`;
        names.set(name, { item, key });
        questions[name] = { ...question, instructions: `Answer for the item with id "${input.idOf(item)}" in state.items. ${typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions)}` } as JevQuestion;
      }
    });
    let response: JevResponse | null = null;
    try {
      response = await jevEvaluate(config, state, questions, { fetchImpl: input.fetchImpl });
    } catch (error) {
      ctx.logger.warn("Jev batch failed; asking one item at a time", { purpose: input.purpose, items: chunk.length, error: error instanceof Error ? error.message : String(error) });
    }
    if (!response) {
      // One bad item or a long request can fail a whole chunk: retry singly so nothing is lost.
      for (const item of chunk) {
        out[index.get(item)!] = await decide(ctx, companyId, {
          config,
          purpose: input.purpose,
          subject: { kind: input.subjectKind, id: input.idOf(item) },
          state: input.context !== undefined ? { context: input.context, item: states.get(item) } : states.get(item),
          questions: input.questions,
          acting: input.acting,
          log: input.log,
          fetchImpl: input.fetchImpl,
        });
      }
      continue;
    }
    const perItem = new Map<T, Record<string, JevAnswer>>(chunk.map((item) => [item, {}]));
    for (const [name, answer] of Object.entries(response.answers ?? {})) {
      const target = names.get(name);
      if (target) perItem.get(target.item)![target.key] = answer;
    }
    const share = Math.round((response.usage?.input_tokens ?? 0) / chunk.length);
    for (const item of chunk) {
      const answers = perItem.get(item)!;
      if (Object.keys(answers).length === 0) {
        out[index.get(item)!] = null;
        continue;
      }
      const ids = await logAnswers(ctx, companyId, { config, purpose: input.purpose, subject: { kind: input.subjectKind, id: input.idOf(item) }, acting: input.acting, log: input.log }, answers, response.model);
      out[index.get(item)!] = { model: response.model, answers, inputTokens: share, ids };
    }
  }
  return out;
}

/** Run `decide` over many items with bounded concurrency (Jev allows ~1,200 requests/min). */
export async function decideMany<T>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<DecisionResult | null>,
): Promise<Array<DecisionResult | null>> {
  const out: Array<DecisionResult | null> = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      try {
        out[index] = await run(items[index]!);
      } catch {
        out[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** A person corrects a logged decision (used as labelled data and to tune rubrics). */
export async function correctDecision(ctx: PluginContext, companyId: string, decisionId: string, correctedTo: string, userId: string | null): Promise<boolean> {
  const res = await ctx.db.execute(
    `UPDATE ${ns(ctx)}.decisions SET corrected_to = $3, corrected_by = $4, corrected_at = now() WHERE id = $1 AND company_id = $2`,
    [decisionId, companyId, correctedTo, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Accuracy per purpose/question from corrections: share of decisions nobody corrected away. */
export async function decisionStats(ctx: PluginContext, companyId: string, sinceDays = 30) {
  return ctx.db.query<{ purpose: string; question_key: string; total: string; corrected: string; avg_confidence: string }>(
    `SELECT purpose, question_key, count(*)::text AS total,
            count(*) FILTER (WHERE corrected_to IS NOT NULL AND corrected_to <> coalesce(value_text, value_num::text))::text AS corrected,
            round(avg(confidence), 3)::text AS avg_confidence
       FROM ${ns(ctx)}.decisions
      WHERE company_id = $1 AND created_at >= now() - ($2 || ' days')::interval
      GROUP BY purpose, question_key ORDER BY purpose, question_key`,
    [companyId, String(sinceDays)],
  );
}

/** Labelled rows for export (training a self-hosted model later). */
export async function exportLabelledDecisions(ctx: PluginContext, companyId: string, purpose: string) {
  return ctx.db.query<Record<string, unknown>>(
    `SELECT id, subject_kind, subject_id, question_key, value_text, value_num, confidence, corrected_to, model, created_at
       FROM ${ns(ctx)}.decisions WHERE company_id = $1 AND purpose = $2 AND corrected_to IS NOT NULL ORDER BY created_at`,
    [companyId, purpose],
  );
}

/** Bucket an amount for `state` so exact balances never leave the server. */
export function amountBucket(minor: number): string {
  const rands = Math.abs(minor) / 100;
  if (rands < 100) return "under R100";
  if (rands < 1_000) return "R100–R1k";
  if (rands < 10_000) return "R1k–R10k";
  if (rands < 50_000) return "R10k–R50k";
  if (rands < 250_000) return "R50k–R250k";
  return "over R250k";
}
