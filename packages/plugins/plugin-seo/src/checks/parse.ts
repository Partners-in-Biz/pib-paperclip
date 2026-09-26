/**
 * Pure parsers for the site checks: robots.txt, sitemaps, HTML head tags,
 * canonicals, JSON-LD, links and images. No network here.
 */

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface CheckFinding {
  category: string;
  severity: FindingSeverity;
  url: string | null;
  finding: string;
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

const ENTITY_MAP: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITY_MAP[code.toLowerCase()] ?? match;
  });
}

function collapse(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

/** Parse the attributes of one start tag (`<meta a="b" c>`). Keys are lower-cased. */
export function parseAttributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = tag.replace(/^<\s*[a-z0-9:-]+/i, "").replace(/\/?>\s*$/, "");
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of body.matchAll(re)) {
    const key = match[1]!.toLowerCase();
    if (key in out) continue;
    out[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return out;
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

export function findTags(html: string, name: string): Array<Record<string, string>> {
  const re = new RegExp(`<${name}\\b[^>]*>`, "gi");
  return [...stripComments(html).matchAll(re)].map((m) => parseAttributes(m[0]));
}

function textOf(html: string, name: string): string[] {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "gi");
  return [...stripComments(html).matchAll(re)].map((m) => collapse(m[1]!.replace(/<[^>]+>/g, " ")));
}

export interface PageMeta {
  title: string | null;
  description: string | null;
  canonicals: string[];
  robots: string | null;
  googlebot: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  twitterCard: string | null;
  h1: string[];
  lang: string | null;
}

export function extractMeta(html: string): PageMeta {
  const metas = findTags(html, "meta");
  const byName = (name: string) => {
    const tag = metas.find((m) => (m.name ?? "").toLowerCase() === name);
    return tag?.content != null ? collapse(tag.content) : null;
  };
  const byProperty = (prop: string) => {
    const tag = metas.find((m) => (m.property ?? m.name ?? "").toLowerCase() === prop);
    return tag?.content != null ? collapse(tag.content) : null;
  };
  const canonicals = findTags(html, "link")
    .filter((l) => (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical") && l.href)
    .map((l) => l.href!.trim());
  const htmlTag = findTags(html, "html")[0];
  const titles = textOf(html, "title");
  return {
    title: titles[0] || null,
    description: byName("description"),
    canonicals,
    robots: byName("robots"),
    googlebot: byName("googlebot"),
    ogTitle: byProperty("og:title"),
    ogDescription: byProperty("og:description"),
    ogImage: byProperty("og:image"),
    twitterCard: byName("twitter:card"),
    h1: textOf(html, "h1").filter(Boolean),
    lang: htmlTag?.lang ?? null,
  };
}

export const TITLE_MIN = 30;
export const TITLE_MAX = 60;
export const DESCRIPTION_MIN = 70;
export const DESCRIPTION_MAX = 160;

export function metaFindings(url: string, meta: PageMeta): CheckFinding[] {
  const out: CheckFinding[] = [];
  const add = (severity: FindingSeverity, finding: string) => out.push({ category: "meta", severity, url, finding });
  if (!meta.title) add("high", "Missing <title>");
  else if (meta.title.length < TITLE_MIN) add("low", `Title is short (${meta.title.length} chars; aim for 50–60)`);
  else if (meta.title.length > TITLE_MAX) add("low", `Title is long (${meta.title.length} chars; Google truncates after ~60)`);
  if (!meta.description) add("medium", "Missing meta description");
  else if (meta.description.length < DESCRIPTION_MIN) add("low", `Meta description is short (${meta.description.length} chars; aim for 70–160)`);
  else if (meta.description.length > DESCRIPTION_MAX) add("low", `Meta description is long (${meta.description.length} chars; max ~160)`);
  if (meta.h1.length === 0) add("medium", "No <h1> on the page");
  else if (meta.h1.length > 1) add("low", `${meta.h1.length} <h1> tags (use one)`);
  if (!meta.ogTitle) add("low", "Missing og:title");
  if (!meta.ogImage) add("low", "Missing og:image");
  if (meta.canonicals.length === 0) add("medium", "Missing canonical link");
  const robots = `${meta.robots ?? ""},${meta.googlebot ?? ""}`.toLowerCase();
  if (/\bnoindex\b|\bnone\b/.test(robots)) add("critical", "Robots meta is noindex — the page will not be indexed");
  return out;
}

// ---------------------------------------------------------------------------
// URLs and canonicals
// ---------------------------------------------------------------------------

/** Comparable form: lower-case host, no default port, no fragment, no trailing slash (except root). */
export function comparableUrl(value: string, base?: string): string | null {
  try {
    const u = new URL(value, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
    let path = u.pathname.replace(/\/+$/, "");
    if (!path) path = "/";
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return null;
  }
}

export function linkHeaderCanonical(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;(.*)$/);
    if (m && /rel\s*=\s*"?canonical"?/i.test(m[2]!)) return m[1]!.trim();
  }
  return null;
}

export interface CanonicalResult {
  url: string;
  canonical: string | null;
  source: "html" | "header" | null;
  matches: boolean;
  findings: CheckFinding[];
}

export function canonicalCheck(input: { requestedUrl: string; finalUrl: string; html: string; linkHeader?: string }): CanonicalResult {
  const meta = extractMeta(input.html);
  const headerCanonical = linkHeaderCanonical(input.linkHeader);
  const findings: CheckFinding[] = [];
  const add = (severity: FindingSeverity, finding: string) =>
    findings.push({ category: "canonical", severity, url: input.finalUrl, finding });
  const distinct = [...new Set(meta.canonicals.map((c) => comparableUrl(c, input.finalUrl)).filter(Boolean))];
  const raw = meta.canonicals[0] ?? headerCanonical;
  const source: CanonicalResult["source"] = meta.canonicals[0] ? "html" : headerCanonical ? "header" : null;
  if (!raw) {
    add("medium", "No canonical (neither <link rel=canonical> nor a Link header)");
    return { url: input.finalUrl, canonical: null, source, matches: false, findings };
  }
  if (distinct.length > 1) add("high", `${distinct.length} different canonical tags on the page`);
  const canonical = comparableUrl(raw, input.finalUrl);
  const self = comparableUrl(input.finalUrl);
  const matches = !!canonical && canonical === self;
  if (!/^https?:\/\//i.test(raw)) add("low", `Canonical is relative (${raw}); use an absolute URL`);
  if (canonical && self && !matches) {
    const c = new URL(canonical);
    const s = new URL(self);
    if (c.host === s.host && c.pathname === s.pathname && c.protocol !== s.protocol) add("high", `Canonical uses ${c.protocol} but the page is served on ${s.protocol}`);
    else add("medium", `Canonical points elsewhere: ${raw}`);
  }
  if (input.requestedUrl !== input.finalUrl) {
    add("info", `Requested URL redirected to ${input.finalUrl}`);
  }
  return { url: input.finalUrl, canonical: canonical ?? raw, source, matches, findings };
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

export const REQUIRED_SCHEMA_PROPS: Record<string, string[]> = {
  SoftwareApplication: ["name", "applicationCategory"],
  FAQPage: ["mainEntity"],
  Article: ["headline"],
  BlogPosting: ["headline"],
  NewsArticle: ["headline"],
  Product: ["name"],
  BreadcrumbList: ["itemListElement"],
  Organization: ["name"],
  LocalBusiness: ["name", "address"],
  ProfessionalService: ["name", "address"],
  WebSite: ["name", "url"],
  Event: ["name", "startDate", "location"],
  Review: ["itemReviewed", "author"],
};

export interface SchemaItem {
  types: string[];
  missing: string[];
  issues: string[];
}

export interface SchemaResult {
  blocks: number;
  invalidBlocks: number;
  types: string[];
  items: SchemaItem[];
  findings: CheckFinding[];
}

function typesOf(item: Record<string, unknown>): string[] {
  const t = item["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

function checkFaq(item: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const entities = Array.isArray(item.mainEntity) ? item.mainEntity : item.mainEntity ? [item.mainEntity] : [];
  if (entities.length === 0) issues.push("FAQPage has no questions");
  entities.forEach((q, i) => {
    const question = q as Record<string, unknown>;
    if (!question || typeof question !== "object") return issues.push(`FAQ item ${i + 1} is not an object`);
    if (!typesOf(question).includes("Question")) issues.push(`FAQ item ${i + 1} is not a Question`);
    if (!question.name) issues.push(`FAQ item ${i + 1} has no name (question text)`);
    const answer = question.acceptedAnswer as Record<string, unknown> | undefined;
    if (!answer || typeof answer !== "object" || !answer.text) issues.push(`FAQ item ${i + 1} has no acceptedAnswer.text`);
    return undefined;
  });
  return issues;
}

export function extractJsonLd(html: string, url: string | null = null): SchemaResult {
  const scripts = [...stripComments(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) =>
    /application\/ld\+json/i.test(parseAttributes(`<script ${m[1]}>`).type ?? ""),
  );
  const findings: CheckFinding[] = [];
  const items: SchemaItem[] = [];
  let invalidBlocks = 0;
  for (const script of scripts) {
    const raw = script[2]!.trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      invalidBlocks += 1;
      findings.push({ category: "schema", severity: "high", url, finding: `Invalid JSON in a JSON-LD block: ${error instanceof Error ? error.message : "parse error"}` });
      continue;
    }
    const queue: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record["@graph"])) {
        queue.push(...(record["@graph"] as unknown[]));
        if (typesOf(record).length === 0) continue;
      }
      const types = typesOf(record);
      if (types.length === 0) {
        items.push({ types: [], missing: [], issues: ["Item has no @type"] });
        findings.push({ category: "schema", severity: "low", url, finding: "A JSON-LD item has no @type" });
        continue;
      }
      const missing = [...new Set(types.flatMap((t) => (REQUIRED_SCHEMA_PROPS[t] ?? []).filter((p) => record[p] == null || record[p] === "")))];
      const issues = types.includes("FAQPage") ? checkFaq(record) : [];
      items.push({ types, missing, issues });
      if (missing.length > 0) findings.push({ category: "schema", severity: "medium", url, finding: `${types.join("/")} missing: ${missing.join(", ")}` });
      for (const issue of issues) findings.push({ category: "schema", severity: "medium", url, finding: issue });
    }
  }
  if (scripts.length === 0) findings.push({ category: "schema", severity: "low", url, finding: "No JSON-LD structured data on the page" });
  if (scripts.length > 0 && !scripts.some((s) => /"@context"\s*:\s*"https?:\/\/schema\.org/i.test(s[2]!))) {
    findings.push({ category: "schema", severity: "low", url, finding: "JSON-LD does not declare @context https://schema.org" });
  }
  return { blocks: scripts.length, invalidBlocks, types: [...new Set(items.flatMap((i) => i.types))], items, findings };
}

// ---------------------------------------------------------------------------
// Links, images, body text
// ---------------------------------------------------------------------------

export function extractLinks(html: string, baseUrl: string): Array<{ url: string; nofollow: boolean }> {
  const out: Array<{ url: string; nofollow: boolean }> = [];
  for (const attrs of findTags(html, "a")) {
    const href = attrs.href?.trim();
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|data):/i.test(href)) continue;
    const url = comparableUrl(href, baseUrl);
    if (!url) continue;
    out.push({ url, nofollow: /\bnofollow\b/i.test(attrs.rel ?? "") });
  }
  return out;
}

export function imagesMissingAlt(html: string, baseUrl?: string): { total: number; missing: string[]; decorative: number } {
  const imgs = findTags(html, "img");
  const missing: string[] = [];
  let decorative = 0;
  for (const img of imgs) {
    if (!("alt" in img)) {
      const src = img.src ?? img["data-src"] ?? "";
      let abs = src;
      try {
        abs = baseUrl ? new URL(src, baseUrl).toString() : src;
      } catch {
        abs = src;
      }
      missing.push(abs || "(no src)");
    } else if (!img.alt!.trim()) {
      decorative += 1;
    }
  }
  return { total: imgs.length, missing, decorative };
}

export function bodyText(html: string): string {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return collapse(
    stripComments(body)
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsGroup {
  agents: string[];
  rules: Array<{ type: "allow" | "disallow"; path: string }>;
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if ((key === "allow" || key === "disallow") && current) current.rules.push({ type: key, path: value });
  }
  return { groups, sitemaps };
}

function ruleMatches(rulePath: string, path: string): boolean {
  if (!rulePath) return false;
  const anchored = rulePath.endsWith("$");
  const pattern = (anchored ? rulePath.slice(0, -1) : rulePath)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
}

function groupFor(robots: ParsedRobots, userAgent: string): RobotsGroup | null {
  const ua = userAgent.toLowerCase();
  let best: RobotsGroup | null = null;
  let bestLen = -1;
  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent !== "*" && ua.includes(agent) && agent.length > bestLen) {
        best = group;
        bestLen = agent.length;
      }
    }
  }
  if (best) return best;
  return robots.groups.find((g) => g.agents.includes("*")) ?? null;
}

/** Google's rule: the most specific (longest) matching rule wins; allow wins a tie. */
export function robotsAllows(robots: ParsedRobots, userAgent: string, path: string): boolean {
  const group = groupFor(robots, userAgent);
  if (!group) return true;
  let verdict: { allow: boolean; len: number } = { allow: true, len: -1 };
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    const len = rule.path.length;
    if (len > verdict.len || (len === verdict.len && rule.type === "allow")) verdict = { allow: rule.type === "allow", len };
  }
  return verdict.allow;
}

export function robotsFindings(input: { url: string; status: number; robots: ParsedRobots }): CheckFinding[] {
  const out: CheckFinding[] = [];
  const add = (severity: FindingSeverity, finding: string) => out.push({ category: "robots", severity, url: input.url, finding });
  if (input.status >= 500) add("high", `robots.txt returns ${input.status}; Google may pause crawling the site`);
  else if (input.status === 404 || input.status === 410) add("info", "No robots.txt (everything may be crawled)");
  else if (input.status >= 400) add("medium", `robots.txt returns ${input.status}`);
  if (input.status < 400) {
    if (!robotsAllows(input.robots, "Googlebot", "/")) add("critical", "robots.txt blocks Googlebot from the home page (Disallow: /)");
    else if (!robotsAllows(input.robots, "*", "/")) add("high", "robots.txt blocks all crawlers from the home page (User-agent: * Disallow: /)");
    if (input.robots.sitemaps.length === 0) add("low", "No Sitemap: line in robots.txt");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sitemaps
// ---------------------------------------------------------------------------

export interface ParsedSitemap {
  kind: "urlset" | "index" | "unknown";
  urls: string[];
  sitemaps: string[];
}

function locs(xml: string, parent: string): string[] {
  const re = new RegExp(`<(?:[a-z0-9]+:)?${parent}\\b[^>]*>([\\s\\S]*?)</(?:[a-z0-9]+:)?${parent}>`, "gi");
  const out: string[] = [];
  for (const block of xml.matchAll(re)) {
    const loc = block[1]!.match(/<(?:[a-z0-9]+:)?loc\b[^>]*>([\s\S]*?)<\/(?:[a-z0-9]+:)?loc>/i)?.[1];
    if (!loc) continue;
    const value = decodeEntities(loc.replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, "").trim());
    if (value) out.push(value);
  }
  return out;
}

export function parseSitemap(xml: string): ParsedSitemap {
  const isIndex = /<(?:[a-z0-9]+:)?sitemapindex\b/i.test(xml);
  const isUrlset = /<(?:[a-z0-9]+:)?urlset\b/i.test(xml);
  if (isIndex) return { kind: "index", urls: [], sitemaps: locs(xml, "sitemap") };
  if (isUrlset) return { kind: "urlset", urls: locs(xml, "url"), sitemaps: [] };
  return { kind: "unknown", urls: [], sitemaps: [] };
}

// ---------------------------------------------------------------------------
// Crawler view
// ---------------------------------------------------------------------------

export interface CrawlerView {
  url: string;
  finalUrl: string;
  status: number;
  redirects: string[];
  blockedByRobots: boolean;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  noindex: boolean;
  nofollow: boolean;
  canonical: string | null;
  canonicalMatches: boolean | null;
  title: string | null;
  h1Count: number;
  bodyTextLength: number;
  scriptCount: number;
  images: { total: number; missingAlt: number; sampleMissing: string[] };
  indexable: boolean;
  findings: CheckFinding[];
}

export function crawlerView(input: {
  url: string;
  finalUrl: string;
  status: number;
  redirects: string[];
  headers: Record<string, string>;
  html: string;
  robots: ParsedRobots | null;
}): CrawlerView {
  const meta = extractMeta(input.html);
  const xRobots = input.headers["x-robots-tag"] ?? null;
  const robotsMeta = [meta.robots, meta.googlebot].filter(Boolean).join(", ") || null;
  const directives = `${robotsMeta ?? ""},${xRobots ?? ""}`.toLowerCase();
  const noindex = /\bnoindex\b|\bnone\b/.test(directives);
  const nofollow = /\bnofollow\b|\bnone\b/.test(directives);
  let path = "/";
  try {
    const u = new URL(input.finalUrl);
    path = `${u.pathname}${u.search}`;
  } catch {
    path = "/";
  }
  const blockedByRobots = input.robots ? !robotsAllows(input.robots, "Googlebot", path) : false;
  const canonicalResult = input.html ? canonicalCheck({ requestedUrl: input.url, finalUrl: input.finalUrl, html: input.html, linkHeader: input.headers.link }) : null;
  const text = bodyText(input.html);
  const scriptCount = (input.html.match(/<script\b/gi) ?? []).length;
  const imgs = imagesMissingAlt(input.html, input.finalUrl);
  const findings: CheckFinding[] = [];
  const add = (severity: FindingSeverity, finding: string) => findings.push({ category: "crawl", severity, url: input.finalUrl, finding });
  if (input.status >= 400) add("critical", `Page returns HTTP ${input.status}`);
  if (input.redirects.length > 1) add("low", `Redirect chain of ${input.redirects.length} hops`);
  if (blockedByRobots) add("critical", "Blocked for Googlebot by robots.txt");
  if (noindex) add("critical", `noindex set (${[robotsMeta, xRobots ? `X-Robots-Tag: ${xRobots}` : null].filter(Boolean).join("; ")})`);
  if (canonicalResult && canonicalResult.canonical && !canonicalResult.matches) add("medium", `Canonical points to ${canonicalResult.canonical}`);
  if (meta.h1.length === 0) add("medium", "No <h1> in the served HTML");
  if (text.length < 200) add("high", `Only ${text.length} characters of text in the served HTML — content may need JavaScript to render`);
  if (imgs.missing.length > 0) {
    findings.push({ category: "images", severity: "low", url: input.finalUrl, finding: `${imgs.missing.length} of ${imgs.total} images have no alt attribute` });
  }
  const indexable = input.status >= 200 && input.status < 300 && !noindex && !blockedByRobots && (canonicalResult?.matches ?? true);
  return {
    url: input.url,
    finalUrl: input.finalUrl,
    status: input.status,
    redirects: input.redirects,
    blockedByRobots,
    robotsMeta,
    xRobotsTag: xRobots,
    noindex,
    nofollow,
    canonical: canonicalResult?.canonical ?? null,
    canonicalMatches: canonicalResult ? canonicalResult.matches : null,
    title: meta.title,
    h1Count: meta.h1.length,
    bodyTextLength: text.length,
    scriptCount,
    images: { total: imgs.total, missingAlt: imgs.missing.length, sampleMissing: imgs.missing.slice(0, 10) },
    indexable,
    findings,
  };
}
