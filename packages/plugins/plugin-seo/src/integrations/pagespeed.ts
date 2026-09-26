/**
 * PageSpeed Insights v5. Field data (Chrome UX Report, `loadingExperience`)
 * wins when Google has it; otherwise the Lighthouse lab audits are used:
 * `largest-contentful-paint`, `cumulative-layout-shift` and (rarely present in
 * navigation runs) `interaction-to-next-paint`.
 */
import type { FetchLike } from "./google.js";

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

export type Strategy = "mobile" | "desktop";

export interface PageHealthRecord {
  url: string;
  strategy: Strategy;
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  labLcpMs: number | null;
  labCls: number | null;
  labInpMs: number | null;
  fieldLcpMs: number | null;
  fieldCls: number | null;
  fieldInpMs: number | null;
  fieldScope: "url" | "origin" | null;
  source: "field" | "lab";
  opportunities: Array<{ id: string; title: string; savingsMs: number | null }>;
}

export function pagespeedRequestUrl(url: string, strategy: Strategy, apiKey?: string | null): string {
  const params = new URLSearchParams({ url, strategy });
  for (const category of ["performance", "seo", "accessibility", "best-practices"]) params.append("category", category);
  if (apiKey) params.set("key", apiKey);
  return `${ENDPOINT}?${params.toString()}`;
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function score(categories: Record<string, unknown>, key: string): number | null {
  const s = num((categories[key] as { score?: unknown } | undefined)?.score);
  return s == null ? null : Math.round(s * 100);
}

export function parsePagespeed(json: unknown, url: string, strategy: Strategy): PageHealthRecord {
  const root = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const lighthouse = (root.lighthouseResult ?? {}) as Record<string, unknown>;
  const categories = (lighthouse.categories ?? {}) as Record<string, unknown>;
  const audits = (lighthouse.audits ?? {}) as Record<string, Record<string, unknown>>;
  const labLcpMs = num(audits["largest-contentful-paint"]?.numericValue);
  const labCls = num(audits["cumulative-layout-shift"]?.numericValue);
  const labInpMs = num(audits["interaction-to-next-paint"]?.numericValue);

  const pickField = (experience: unknown) => {
    const metrics = ((experience as { metrics?: unknown } | undefined)?.metrics ?? {}) as Record<string, { percentile?: unknown }>;
    const lcp = num(metrics.LARGEST_CONTENTFUL_PAINT_MS?.percentile);
    const clsRaw = num(metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile);
    const inp = num(metrics.INTERACTION_TO_NEXT_PAINT?.percentile);
    // CrUX reports CLS ×100 (e.g. 5 means 0.05).
    return { lcp, cls: clsRaw == null ? null : clsRaw / 100, inp };
  };
  const loading = root.loadingExperience as Record<string, unknown> | undefined;
  const originLoading = root.originLoadingExperience as Record<string, unknown> | undefined;
  let field = pickField(loading);
  let fieldScope: PageHealthRecord["fieldScope"] = null;
  if (field.lcp != null || field.cls != null || field.inp != null) {
    fieldScope = loading?.origin_fallback ? "origin" : "url";
  } else {
    field = pickField(originLoading);
    if (field.lcp != null || field.cls != null || field.inp != null) fieldScope = "origin";
  }
  const useField = fieldScope === "url";
  const opportunities = Object.entries(audits)
    .filter(([, a]) => (a.details as { type?: string } | undefined)?.type === "opportunity" && (num(a.score) ?? 1) < 0.9)
    .map(([id, a]) => ({
      id,
      title: String(a.title ?? id),
      savingsMs: num((a.details as { overallSavingsMs?: unknown } | undefined)?.overallSavingsMs),
    }))
    .sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0))
    .slice(0, 5);
  return {
    url,
    strategy,
    performance: score(categories, "performance"),
    seo: score(categories, "seo"),
    accessibility: score(categories, "accessibility"),
    bestPractices: score(categories, "best-practices"),
    lcpMs: useField && field.lcp != null ? field.lcp : labLcpMs,
    cls: useField && field.cls != null ? field.cls : labCls,
    inpMs: useField && field.inp != null ? field.inp : labInpMs,
    labLcpMs,
    labCls,
    labInpMs,
    fieldLcpMs: field.lcp,
    fieldCls: field.cls,
    fieldInpMs: field.inp,
    fieldScope,
    source: useField ? "field" : "lab",
    opportunities,
  };
}

export async function runPagespeed(
  fetchImpl: FetchLike,
  input: { url: string; strategy?: Strategy; apiKey?: string | null; timeoutMs?: number },
): Promise<PageHealthRecord> {
  const strategy = input.strategy ?? "mobile";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 26_000);
  try {
    const res = await fetchImpl(pagespeedRequestUrl(input.url, strategy, input.apiKey), { signal: controller.signal, headers: { Accept: "application/json" } });
    const text = await res.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const message = ((json as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`).slice(0, 300);
      throw new Error(`PageSpeed Insights failed for ${input.url}: ${message}`);
    }
    return parsePagespeed(json, input.url, strategy);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`PageSpeed Insights took too long for ${input.url}; try again later`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function cwvFindings(record: PageHealthRecord): Array<{ severity: "high" | "medium"; finding: string }> {
  const out: Array<{ severity: "high" | "medium"; finding: string }> = [];
  if (record.lcpMs != null && record.lcpMs > 2500) {
    out.push({ severity: record.lcpMs > 4000 ? "high" : "medium", finding: `LCP ${(record.lcpMs / 1000).toFixed(1)} s (${record.source}); target < 2.5 s` });
  }
  if (record.cls != null && record.cls > 0.1) {
    out.push({ severity: record.cls > 0.25 ? "high" : "medium", finding: `CLS ${record.cls.toFixed(2)} (${record.source}); target < 0.1` });
  }
  if (record.inpMs != null && record.inpMs > 200) {
    out.push({ severity: record.inpMs > 500 ? "high" : "medium", finding: `INP ${Math.round(record.inpMs)} ms (${record.source}); target < 200 ms` });
  }
  return out;
}
