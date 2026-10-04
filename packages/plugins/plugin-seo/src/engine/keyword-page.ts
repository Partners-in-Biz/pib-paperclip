/**
 * Decide before you write: for one keyword, does a page of the site already earn it? Pure rules over Search Console
 * rows (page, query, clicks, impressions, position). Writing a second page for a query a page already serves makes two
 * pages fight for it, so the answer is "optimise that page" unless nothing earns the keyword yet.
 */
export interface GscRow {
  page: string;
  query: string;
  position: number;
  impressions: number;
  clicks: number;
}

export type KeywordPageDecision = "optimise" | "merge" | "create" | "unknown";

export interface PageEarnings {
  page: string;
  clicks: number;
  impressions: number;
  /** Best (lowest) average position among the rows that matched the keyword. */
  position: number;
}

export interface KeywordPageResult {
  decision: KeywordPageDecision;
  reason: string;
  /** The page to optimise (or keep when merging); null when the decision is create. */
  page: string | null;
  /** Pages that earn the keyword, strongest first. */
  pages: PageEarnings[];
  /** Other queries the chosen page ranks in the top 5 for: the page's secondary keywords. */
  secondary: Array<{ query: string; position: number; impressions: number }>;
}

/** Enough impressions in the window that a page is clearly "somewhere in the top 10" for the query. */
export const MIN_IMPRESSIONS = 20;
/** The second page holds at least this share of the leader's impressions before the pair counts as fighting. */
export const CANNIBAL_SHARE = 0.25;

const norm = (value: string): string => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function earningPages(rows: GscRow[], keyword: string): PageEarnings[] {
  const wanted = norm(keyword);
  const byPage = new Map<string, PageEarnings>();
  for (const row of rows) {
    if (norm(row.query) !== wanted) continue;
    const have = byPage.get(row.page);
    if (have) {
      have.clicks += row.clicks;
      have.impressions += row.impressions;
      have.position = Math.min(have.position, row.position);
    } else byPage.set(row.page, { page: row.page, clicks: row.clicks, impressions: row.impressions, position: row.position });
  }
  return [...byPage.values()].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

export function secondaryQueries(rows: GscRow[], page: string, keyword: string): KeywordPageResult["secondary"] {
  const wanted = norm(keyword);
  return rows
    .filter((r) => r.page === page && norm(r.query) !== wanted && r.position <= 5)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 15)
    .map((r) => ({ query: r.query, position: r.position, impressions: r.impressions }));
}

export function decideKeywordPage(keywordRows: GscRow[], pageRows: GscRow[], keyword: string): KeywordPageResult {
  const pages = earningPages(keywordRows, keyword).filter((p) => p.clicks > 0 || p.impressions >= MIN_IMPRESSIONS);
  if (pages.length === 0) {
    return { decision: "create", reason: "No page of the site gets clicks or enough impressions for this exact keyword in the window, so a new page does not compete with an existing one.", page: null, pages: [], secondary: [] };
  }
  const lead = pages[0]!;
  const rival = pages[1];
  const secondary = secondaryQueries(pageRows, lead.page, keyword);
  if (rival && rival.impressions >= lead.impressions * CANNIBAL_SHARE) {
    return {
      decision: "merge",
      reason: `Two pages compete for this keyword (${lead.page} and ${rival.page}). Pick the stronger one, move what the other has into it and redirect the weaker page. Do not write a third.`,
      page: lead.page,
      pages,
      secondary,
    };
  }
  return {
    decision: "optimise",
    reason: `${lead.page} already earns this keyword (${lead.clicks} clicks, ${lead.impressions} impressions, position ${Math.round(lead.position * 10) / 10}). Improve that page. Do not create a new one.`,
    page: lead.page,
    pages,
    secondary,
  };
}
