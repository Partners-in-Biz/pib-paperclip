/**
 * Two agent tools that stop expensive SEO mistakes before they are made:
 * `page-diff` (the diff gate: what a changed page lost) and `page-for-keyword` (decide before you write: does a page
 * already earn this keyword). Both are read-only.
 */
import { diffPages, diffSummary } from "../checks/page-diff.js";
import { decideKeywordPage, type GscRow } from "../engine/keyword-page.js";
import { reqStr, SeoError, str, urlParam, type Env, type Params } from "./common.js";
import { requireSprint } from "./context.js";
import { gscQuery } from "./gsc.js";

const MAX_HTML = 600_000;
const ACCEPT = { Accept: "text/html,application/xhtml+xml" };

async function pageHtml(env: Env, url: string): Promise<{ html: string; url: string; status: number }> {
  const res = await env.site(url, { headers: ACCEPT, maxChars: MAX_HTML });
  if (res.status >= 400) throw new SeoError(`${url} returned HTTP ${res.status}, so it cannot be compared.`);
  return { html: res.text, url: res.url, status: res.status };
}

/** Agent tool: compare the live page with the changed version (a preview or staging address, or the HTML itself). */
export async function pageDiffTool(env: Env, companyId: string, params: Params) {
  const sprintId = str(params, "sprintId");
  const sprint = sprintId ? await requireSprint(env, companyId, sprintId) : null;
  const url = urlParam(reqStr(params, "url", { max: 2000 }), sprint?.siteUrl);
  const afterUrl = str(params, "afterUrl", { max: 2000 });
  const afterHtml = typeof params.afterHtml === "string" ? params.afterHtml : undefined;
  if (!afterUrl && !afterHtml) throw new SeoError("Pass afterUrl (the preview or staging address of the changed page) or afterHtml (the changed page's HTML).");
  if (afterHtml && afterHtml.length > MAX_HTML) throw new SeoError(`afterHtml is over ${MAX_HTML} characters: pass afterUrl instead.`);
  const before = await pageHtml(env, url);
  const after = afterHtml ? { html: afterHtml, url: before.url } : await pageHtml(env, urlParam(afterUrl!, sprint?.siteUrl ?? url));
  // Links on a preview host would all look foreign: judge them against the live page's address.
  const diff = diffPages({ html: before.html, url: before.url }, { html: after.html, url: before.url });
  return {
    url: before.url,
    compared: afterHtml ? "the HTML you passed" : after.url,
    summary: diffSummary(diff),
    clean: diff.lost.length === 0,
    lost: diff.lost.slice(0, 60).map((e) => ({ kind: e.kind, what: e.label })),
    lostCount: diff.lost.length,
    gained: diff.gained.slice(0, 30).map((e) => ({ kind: e.kind, what: e.label })),
    gainedCount: diff.gained.length,
    kept: diff.kept,
    words: diff.words,
    next: diff.lost.length === 0
      ? "Put this summary in the task's evidence. Nothing was dropped."
      : "Restore every lost element, or write each one into the evidence as removed on purpose with the reason. Run page-diff again. A change with an unexplained loss goes back to the builder.",
  };
}

function rowsOf(result: unknown): GscRow[] {
  const rows = (result as { rows?: Array<Record<string, unknown>> }).rows ?? [];
  return rows.map((r) => ({
    page: String(r.page ?? ""),
    query: String(r.query ?? ""),
    position: Number(r.position ?? 0),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
  }));
}

/** Agent tool: optimise, merge or create? Reads the last 90 days of Search Console for the exact keyword. */
export async function pageForKeywordTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const keyword = reqStr(params, "keyword", { max: 200 });
  let keywordRows: GscRow[];
  try {
    keywordRows = rowsOf(await gscQuery(env, companyId, { sprintId: sprint.id, query: keyword, days: 90, limit: 500 }));
  } catch (error) {
    if (!(error instanceof SeoError)) throw error;
    return {
      sprintId: sprint.id,
      keyword,
      decision: "unknown" as const,
      reason: `Search Console could not be read (${error.message}). Do not create a page on a guess: check Search Console by hand for this keyword, or put the access problem on Needs you.`,
      page: null,
      pages: [],
      secondary: [],
    };
  }
  let result = decideKeywordPage(keywordRows, [], keyword);
  if (result.page) {
    const pageRows = rowsOf(await gscQuery(env, companyId, { sprintId: sprint.id, page: result.page, days: 90, limit: 500 }));
    result = decideKeywordPage(keywordRows, pageRows, keyword);
  }
  return {
    sprintId: sprint.id,
    keyword,
    window: "last 90 days",
    ...result,
    next:
      result.decision === "create"
        ? "Nothing earns this keyword yet: a new page is fine. Still check the title and the five internal links before you ship."
        : "Do not write a new page. Open the page above, add the secondary keywords to its title and sections, and run page-diff before it goes to review.",
  };
}
