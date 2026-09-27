/**
 * Jev for memory briefs: per-company settings (Cockpit settings → `jev`) and
 * the batched calls. Only the task's title, a trimmed description and the
 * candidate facts' text are sent. Without a key, or when Jev is slow or down,
 * callers fall back to the keyword baseline, so a brief never fails.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { decisionConfig, jevEvaluate, readConfig, SecretResolver, type DecisionClientConfig, type JevResponse } from "@partnersinbiz/pib-plugin-kit";
import { SELECTION, type JevBatch } from "./engine.js";

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: DecisionClientConfig | null }>();

/** Jev settings for a company, or null (no key, or switched off). Cached for five minutes. */
export async function memoryJevConfig(ctx: PluginContext, companyId: string): Promise<DecisionClientConfig | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let value: DecisionClientConfig | null = null;
  try {
    const config = await readConfig(ctx, companyId);
    value = await decisionConfig(new SecretResolver(ctx, companyId, config), config);
  } catch (error) {
    ctx.logger.info("Memory: Jev settings could not be read; using the keyword baseline", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

export function clearMemoryJevCache(): void {
  cache.clear();
}

export interface JevRun {
  answers: Array<JevResponse["answers"] | null>;
  model: string | null;
  inputTokens: number;
  failures: number;
}

/** Runs the batches in parallel (small pool). A failed batch is null; the rest still count. */
export async function runJevBatches(config: DecisionClientConfig, batches: JevBatch[], fetchImpl?: typeof fetch): Promise<JevRun> {
  const fast: DecisionClientConfig = { ...config, timeoutMs: SELECTION.jevTimeoutMs };
  const answers: Array<JevResponse["answers"] | null> = new Array(batches.length).fill(null);
  let model: string | null = null;
  let inputTokens = 0;
  let failures = 0;
  let next = 0;
  const workers = Array.from({ length: Math.min(3, batches.length) }, async () => {
    while (next < batches.length) {
      const index = next++;
      const batch = batches[index]!;
      try {
        const res = await jevEvaluate(fast, batch.state, batch.questions, { fetchImpl, maxRetries: 1 });
        answers[index] = res.answers ?? null;
        model = res.model ?? model;
        inputTokens += res.usage?.input_tokens ?? 0;
      } catch {
        failures += 1;
      }
    }
  });
  await Promise.all(workers);
  return { answers, model, inputTokens, failures };
}

/** One Jev call (client choice, duplicate checks). Null on any failure. */
export async function jevOnce(config: DecisionClientConfig, state: unknown, questions: Parameters<typeof jevEvaluate>[2], fetchImpl?: typeof fetch): Promise<JevResponse | null> {
  try {
    return await jevEvaluate({ ...config, timeoutMs: SELECTION.jevTimeoutMs }, state, questions, { fetchImpl, maxRetries: 1 });
  } catch {
    return null;
  }
}
