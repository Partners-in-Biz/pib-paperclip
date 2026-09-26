/**
 * Keyword discovery without paid tools: Google Autocomplete suggestions plus
 * seed variants, with a simple intent guess. Volumes are never invented.
 */
import type { FetchLike } from "./google.js";

export type Intent = "problem" | "solution" | "brand";

export interface KeywordCandidate {
  phrase: string;
  source: "autocomplete" | "seed-variant";
  seed: string;
  intent: Intent;
}

export function seedVariants(seed: string): string[] {
  const s = seed.trim();
  return [`${s} alternative`, `${s} vs`, `best ${s}`, `how to ${s}`, `${s} for small business`, `${s} pricing`];
}

const PROBLEM_START = /^(how|what|why|when|where|can|does|do|is|are|should|which)\b/;
const PROBLEM_WORDS = /\b(how to|tips|guide|ideas|examples|problem|fix|mistakes|checklist|template)\b/;
const SOLUTION_WORDS = /\b(vs|versus|best|alternatives?|top|review|reviews|pricing|price|cost|compare|comparison|software|tool|tools|service|services|company|companies|agency|near me|hire|for small business)\b/;

export function inferIntent(phrase: string, brandTerms: string[] = []): Intent {
  const p = phrase.toLowerCase().trim();
  const brands = brandTerms.map((b) => b.toLowerCase().trim()).filter((b) => b.length >= 3);
  if (brands.some((b) => p.includes(b))) return "brand";
  if (PROBLEM_START.test(p) || PROBLEM_WORDS.test(p)) return "problem";
  if (SOLUTION_WORDS.test(p)) return "solution";
  // Generic head terms are usually people looking for a provider.
  return "solution";
}

/** Firefox-client format: `["query", ["suggestion", …]]`. */
export function parseAutocomplete(json: unknown): string[] {
  if (!Array.isArray(json) || !Array.isArray(json[1])) return [];
  return (json[1] as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim());
}

export async function autocomplete(fetchImpl: FetchLike, query: string, opts: { language?: string; country?: string } = {}): Promise<string[]> {
  const params = new URLSearchParams({ client: "firefox", q: query, hl: opts.language ?? "en" });
  if (opts.country) params.set("gl", opts.country);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetchImpl(`https://suggestqueries.google.com/complete/search?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; PiB-SEO/1.0)" },
    });
    if (!res.ok) return [];
    const buf = await res.arrayBuffer();
    // The endpoint may answer in Latin-1 for some locales; UTF-8 first.
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("�")) text = new TextDecoder("latin1").decode(buf);
    return parseAutocomplete(JSON.parse(text));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function discoverKeywords(
  fetchImpl: FetchLike,
  input: { seeds: string[]; limit?: number; language?: string; country?: string; brandTerms?: string[]; exclude?: string[] },
): Promise<KeywordCandidate[]> {
  const seeds = [...new Set(input.seeds.map((s) => s.trim()).filter(Boolean))].slice(0, 8);
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200);
  const exclude = new Set((input.exclude ?? []).map((e) => e.toLowerCase().trim()));
  const seen = new Set<string>();
  const out: KeywordCandidate[] = [];
  const push = (phrase: string, source: KeywordCandidate["source"], seed: string) => {
    const key = phrase.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key) || exclude.has(key)) return;
    seen.add(key);
    out.push({ phrase: key, source, seed, intent: inferIntent(key, input.brandTerms) });
  };
  const queries = seeds.flatMap((seed) => [seed, ...seedVariants(seed).filter((v) => !v.startsWith("how to"))].map((q) => ({ seed, q })));
  const results = await Promise.all(
    queries.slice(0, 40).map(async ({ seed, q }) => ({ seed, suggestions: await autocomplete(fetchImpl, q, input) })),
  );
  for (const { seed, suggestions } of results) for (const s of suggestions) push(s, "autocomplete", seed);
  for (const seed of seeds) for (const v of seedVariants(seed)) push(v, "seed-variant", seed);
  return out.slice(0, limit);
}
