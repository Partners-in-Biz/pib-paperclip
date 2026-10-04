/**
 * Keyword intent with Jev (Outrank-90 buckets), falling back to the regex
 * guess (`inferIntent`) when Jev is not set up, fails, or is below the
 * `update` confidence threshold. Jev sees only the keyword phrase and the
 * site name. Keywords go to Jev many to a request (kit `decideBatch`: the site name is sent once, a request holds up to 25
 * keywords) and every answer is logged in the plugin's `decisions` table.
 */
import { decideBatch, decisionConfig, shouldAct, type JevQuestions } from "@partnersinbiz/pib-plugin-kit";
import { NAMESPACE } from "../namespace.js";
import type { Intent } from "../integrations/autocomplete.js";
import { loadSeoConfig } from "../config.js";
import type { Env } from "./common.js";

/** Keywords judged in one Jev request (was: one request per keyword, 8 at a time). */
export const INTENT_PER_REQUEST = 25;
export const INTENT_CONCURRENCY = INTENT_PER_REQUEST;

export const INTENT_QUESTIONS: JevQuestions = {
  intent: {
    type: "choice",
    instructions:
      "The item is a search keyword; the website it is being tracked for, when given, is the shared site in the context. Which Outrank-90 intent bucket does a person typing this keyword belong to?",
    criteria: {
      problem: "Researching the pain or a question, not yet comparing providers: how to, why, what is, tips, guides, examples, fixes, checklists.",
      solution: "Comparing options or looking for a product, service or provider to solve it: best, vs, alternatives, reviews, pricing, near me, hire, agency, software.",
      brand: "Looking for this site's own business, brand or product by name.",
    },
  },
};

const INTENTS: readonly Intent[] = ["problem", "solution", "brand"];

export interface IntentItem {
  phrase: string;
  /** The regex guess, kept when Jev is unsure or unavailable. */
  fallback: Intent;
}

export interface IntentResult {
  intent: Intent;
  source: "jev" | "rules";
  confidence: number | null;
}

/** Classify keyword intents for one company; order matches `items`. */
export async function classifyIntents(
  env: Env,
  companyId: string,
  items: IntentItem[],
  context: { siteName: string | null; sprintId: string | null },
): Promise<IntentResult[]> {
  const rules = items.map((item): IntentResult => ({ intent: item.fallback, source: "rules", confidence: null }));
  if (items.length === 0) return rules;
  let config = null;
  try {
    const loaded = await loadSeoConfig(env.ctx, companyId);
    config = await decisionConfig(loaded.secrets, loaded.raw);
  } catch (error) {
    env.ctx.logger.info("Jev settings could not be read; using the intent rules", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
  if (!config) return rules;
  const site = context.siteName?.trim() || null;
  const decisions = await decideBatch(env.ctx, companyId, {
    config,
    purpose: "seo.keyword-intent",
    subjectKind: "keyword",
    items,
    idOf: (item) => `${context.sprintId ?? "discover"}:${item.phrase.toLowerCase()}`,
    stateOf: (item) => ({ keyword: item.phrase }),
    context: site ? { site } : undefined,
    questions: INTENT_QUESTIONS,
    maxItems: INTENT_PER_REQUEST,
    fetchImpl: env.fetch as typeof fetch,
  });
  const out: IntentResult[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const answer = decisions[i]?.answers.intent;
    const choice = answer && answer.type === "choice" && (INTENTS as readonly string[]).includes(answer.choice) ? (answer.choice as Intent) : null;
    if (choice && shouldAct(answer, "update")) {
      out.push({ intent: choice, source: "jev", confidence: answer!.type === "choice" ? answer!.confidence : null });
      const id = decisions[i]?.ids.intent;
      if (id) {
        await env.ctx.db.execute(`UPDATE ${NAMESPACE}.decisions SET acted = true WHERE id = $1`, [id]).catch(() => undefined);
      }
    } else {
      out.push({ ...rules[i]!, confidence: answer && answer.type === "choice" ? answer.confidence : null });
    }
  }
  return out;
}
