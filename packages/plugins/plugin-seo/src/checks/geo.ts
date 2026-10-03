/**
 * GEO (AI search) checks: can AI answer engines reach the site, does the site say who the business is, and is its
 * content easy to quote? Pure parsers and scoring, plus one runner that fetches through the SSRF-guarded
 * `SiteFetcher` (like site.ts, bounded by a deadline so it fits the host's 30 s tool limit).
 *
 * The score is a READINESS score from things this plugin can verify on the site. It is not a measure of how often
 * AI assistants mention the business: that is sampled by the agent and recorded separately (engine/geo.ts), because
 * the plugin has no access to any AI provider and never invents a number.
 */
import {
  bodyText,
  extractMeta,
  findTags,
  jsonLdNodes,
  parseRobots,
  parseSitemap,
  ruleMatches,
  type CheckFinding,
  type FindingSeverity,
  type ParsedRobots,
  type RobotsGroup,
} from "./parse.js";
import { mapLimit, originOf, type SiteFetcher } from "./site.js";

// ---------------------------------------------------------------------------
// AI crawlers
// ---------------------------------------------------------------------------

/**
 * search: finds pages to cite in an AI answer (blocking it means the site is not cited there);
 * user: opens a page when a person asks the assistant about it;
 * training: collects pages to train models. Blocking those is the client's policy choice, not a defect.
 */
export type AiBotKind = "search" | "user" | "training";

export interface AiBot {
  /** The robots.txt user-agent token. */
  token: string;
  vendor: string;
  /** The product people know it by. */
  product: string;
  kind: AiBotKind;
  purpose: string;
}

export const AI_BOTS: AiBot[] = [
  { token: "OAI-SearchBot", vendor: "OpenAI", product: "ChatGPT search", kind: "search", purpose: "finds pages to cite in ChatGPT search answers" },
  { token: "Claude-SearchBot", vendor: "Anthropic", product: "Claude search", kind: "search", purpose: "finds pages to cite in Claude's search answers" },
  { token: "PerplexityBot", vendor: "Perplexity", product: "Perplexity", kind: "search", purpose: "finds pages to cite in Perplexity answers" },
  { token: "Googlebot", vendor: "Google", product: "Google Search, AI Overviews and AI Mode", kind: "search", purpose: "Google's search crawler; AI Overviews and AI Mode draw on the same index" },
  { token: "bingbot", vendor: "Microsoft", product: "Bing and Copilot", kind: "search", purpose: "Bing's crawler; Copilot answers draw on the same index" },
  { token: "Applebot", vendor: "Apple", product: "Siri and Apple search", kind: "search", purpose: "Apple's search crawler" },
  { token: "ChatGPT-User", vendor: "OpenAI", product: "ChatGPT (a person asks about the page)", kind: "user", purpose: "opens a page when a ChatGPT user asks about it" },
  { token: "Claude-User", vendor: "Anthropic", product: "Claude (a person asks about the page)", kind: "user", purpose: "opens a page when a Claude user asks about it" },
  { token: "Perplexity-User", vendor: "Perplexity", product: "Perplexity (a person asks about the page)", kind: "user", purpose: "opens a page when a Perplexity user asks about it" },
  { token: "DuckAssistBot", vendor: "DuckDuckGo", product: "DuckDuckGo AI answers", kind: "user", purpose: "fetches pages to answer a DuckDuckGo AI question" },
  { token: "GPTBot", vendor: "OpenAI", product: "OpenAI model training", kind: "training", purpose: "collects pages to train OpenAI models" },
  { token: "ClaudeBot", vendor: "Anthropic", product: "Anthropic model training", kind: "training", purpose: "collects pages to train Anthropic models" },
  { token: "Google-Extended", vendor: "Google", product: "Gemini training and grounding", kind: "training", purpose: "a control token (not a crawler): blocking it opts the site out of Gemini training and grounding, and does not touch Search or AI Overviews" },
  { token: "Applebot-Extended", vendor: "Apple", product: "Apple model training", kind: "training", purpose: "a control token: blocking it opts the site out of Apple's AI training" },
  { token: "CCBot", vendor: "Common Crawl", product: "Common Crawl datasets", kind: "training", purpose: "builds the open web archive many models train on" },
  { token: "meta-externalagent", vendor: "Meta", product: "Meta AI training", kind: "training", purpose: "collects pages to train Meta's models" },
  { token: "Bytespider", vendor: "ByteDance", product: "ByteDance model training", kind: "training", purpose: "collects pages to train ByteDance's models" },
];

export interface BotAccess {
  token: string;
  vendor: string;
  product: string;
  kind: AiBotKind;
  purpose: string;
  state: "allowed" | "partial" | "blocked";
  /** Sample paths the rules block (empty when allowed). */
  blockedPaths: string[];
  /** own-rule: robots.txt has a group for this bot; wildcard: only `User-agent: *` applies; no-rule: nothing applies. */
  via: "own-rule" | "wildcard" | "no-rule";
}

function rulesFor(robots: ParsedRobots, token: string): { rules: RobotsGroup["rules"]; via: BotAccess["via"] } {
  const own = robots.groups.filter((g) => g.agents.includes(token.toLowerCase()));
  if (own.length > 0) return { rules: own.flatMap((g) => g.rules), via: "own-rule" };
  const any = robots.groups.filter((g) => g.agents.includes("*"));
  if (any.length > 0) return { rules: any.flatMap((g) => g.rules), via: "wildcard" };
  return { rules: [], via: "no-rule" };
}

/** Google's rule: the longest matching rule wins, allow wins a tie. */
function allowedByRules(rules: RobotsGroup["rules"], path: string): boolean {
  let verdict = { allow: true, len: -1 };
  for (const rule of rules) {
    if (!ruleMatches(rule.path, path)) continue;
    const len = rule.path.length;
    if (len > verdict.len || (len === verdict.len && rule.type === "allow")) verdict = { allow: rule.type === "allow", len };
  }
  return verdict.allow;
}

/** What robots.txt says about each AI crawler, for the given sample paths. `robots` null = no robots.txt: everything is allowed. */
export function aiBotAccess(robots: ParsedRobots | null, paths: string[] = ["/"], bots: AiBot[] = AI_BOTS): BotAccess[] {
  const samples = paths.length > 0 ? paths : ["/"];
  return bots.map((bot) => {
    const { rules, via } = robots ? rulesFor(robots, bot.token) : { rules: [], via: "no-rule" as const };
    const blockedPaths = samples.filter((path) => !allowedByRules(rules, path));
    return {
      token: bot.token,
      vendor: bot.vendor,
      product: bot.product,
      kind: bot.kind,
      purpose: bot.purpose,
      state: blockedPaths.length === 0 ? "allowed" : blockedPaths.length === samples.length ? "blocked" : "partial",
      blockedPaths,
      via,
    };
  });
}

export function aiRobotsFindings(access: BotAccess[], robotsUrl: string): CheckFinding[] {
  const out: CheckFinding[] = [];
  const add = (severity: FindingSeverity, finding: string) => out.push({ category: "geo", severity, url: robotsUrl, finding });
  const wildcard = access.filter((a) => a.state === "blocked" && a.via === "wildcard" && a.kind !== "training");
  if (wildcard.length > 0) {
    add("critical", "robots.txt blocks every crawler, AI search included (User-agent: * Disallow: /): no AI answer engine can cite the site");
  }
  const kept = access.find((a) => a.state === "partial" && a.via === "wildcard" && a.kind !== "training");
  if (kept) add("low", `robots.txt keeps every crawler out of part of the site (${kept.blockedPaths.slice(0, 3).join(", ")}): check that is on purpose`);
  for (const a of access) {
    if (a.state === "allowed") continue;
    if (a.via === "wildcard") continue; // a rule for every crawler: said once above, not a choice about AI
    const where = a.state === "partial" ? ` from part of the site (${a.blockedPaths.slice(0, 3).join(", ")})` : "";
    if (a.kind === "search") add(a.state === "blocked" ? "high" : "medium", `robots.txt blocks ${a.token} (${a.product})${where}: the site cannot be cited there`);
    else if (a.kind === "user") add("low", `robots.txt blocks ${a.token} (${a.product})${where}: that assistant cannot open the page when a person asks about it`);
    else add("info", `robots.txt blocks ${a.token} (${a.product})${where}: a choice about training use, not a defect (the client decides)`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Does the server let AI crawlers in? (a firewall or CDN rule can refuse them whatever robots.txt says)
// ---------------------------------------------------------------------------

/** The bots probed with their own user agent (the host cannot fetch from their IP ranges, so this sees user-agent rules only). */
export const PROBED_BOTS = ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot", "GPTBot", "ClaudeBot"] as const;

export function botUserAgent(token: string): string {
  return `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ${token}/1.0; +https://www.${token.toLowerCase().replace(/[^a-z]/g, "")}.com/bot)`;
}

export interface BotProbe {
  token: string;
  kind: AiBotKind;
  status: number;
  /** The server refused the bot or served it a challenge page while a normal request worked. */
  blocked: boolean;
  detail: string | null;
}

const REFUSED_STATUSES = new Set([401, 403, 406, 429, 451, 503]);
const CHALLENGE_PAGE = /just a moment|attention required|cf-browser-verification|cf-chl|enable javascript and cookies|access denied|captcha|are you a robot|bot protection|request blocked/i;

type Reply = { status: number; text: string; headers: Record<string, string> };

/** Compare a bot's reply with a normal request's. null when the normal request did not work either (nothing to compare). */
export function judgeProbe(bot: Pick<AiBot, "token" | "kind">, base: Reply, probe: Reply): BotProbe | null {
  if (base.status < 200 || base.status >= 300) return null;
  const refused = REFUSED_STATUSES.has(probe.status) || probe.status >= 500;
  const challenged = !refused && (probe.headers["cf-mitigated"] === "challenge" || (CHALLENGE_PAGE.test(probe.text.slice(0, 4000)) && !CHALLENGE_PAGE.test(base.text.slice(0, 4000))));
  const blocked = refused || challenged;
  return {
    token: bot.token,
    kind: bot.kind,
    status: probe.status,
    blocked,
    detail: refused ? `HTTP ${probe.status}` : challenged ? "a bot-check page instead of the content" : null,
  };
}

export function probeFindings(probes: BotProbe[], url: string): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const probe of probes) {
    if (!probe.blocked) continue;
    const bot = AI_BOTS.find((b) => b.token === probe.token);
    const where = "Look at the site's firewall or CDN (for example Cloudflare → Security → Bots, or a host's bot protection).";
    if (probe.kind === "search") out.push({ category: "geo", severity: "high", url, finding: `The server refuses ${probe.token} (${probe.detail}) although robots.txt may allow it: AI search cannot read the site. ${where}` });
    else if (probe.kind === "user") out.push({ category: "geo", severity: "low", url, finding: `The server refuses ${probe.token} (${probe.detail}). ${where}` });
    else out.push({ category: "geo", severity: "info", url, finding: `The server refuses ${probe.token} (${probe.detail}) (${bot?.product ?? "training"}): the client's choice if it is on purpose.` });
  }
  return out;
}

/**
 * A refusal seen once is not yet a rule about AI bots. An audit sends about nine requests at once from this server's
 * address: that can trip a rate limit, and a CDN that lets the real bots in by their own addresses turns a look-alike
 * away. So every refusal of a search or user bot is tried once more, one request after the other, next to a request with
 * an ordinary user agent. Refused again while the ordinary request works: kept. The ordinary request is refused too
 * (rate limiting) or the bot now gets through (a blip): not counted. Training bots are not confirmed: they are only information.
 */
export async function confirmRefusals(
  fetcher: SiteFetcher,
  home: string,
  first: BotProbe[],
  deadlineAt: number,
): Promise<{ probes: BotProbe[]; undecided: string[]; notes: string[] }> {
  const refused = first.filter((p) => p.blocked && p.kind !== "training");
  if (refused.length === 0) return { probes: first, undecided: [], notes: [] };
  const names = refused.map((p) => p.token).join(", ");
  const control = await mapLimit([home], 1, deadlineAt, (url) => fetcher(url, { headers: { Accept: "text/html,application/xhtml+xml" }, maxChars: 4_000 }));
  const normal = control.results[0];
  if (!normal || normal.status < 200 || normal.status >= 300) {
    return {
      probes: first.filter((p) => !refused.includes(p)),
      undecided: refused.map((p) => p.token),
      notes: [`${names} got refused, but an ordinary request a moment later ${normal ? `answered HTTP ${normal.status} too` : "did not answer"}: that looks like rate limiting, not a rule about AI bots, so it was not counted`],
    };
  }
  const base: Reply = { status: normal.status, text: normal.text, headers: normal.headers };
  const again = await mapLimit(refused, 1, deadlineAt, async (p) => ({ token: p.token, res: await fetcher(home, { headers: { "User-Agent": botUserAgent(p.token), Accept: "text/html,*/*" }, maxChars: 4_000 }) }));
  const verdicts = new Map<string, BotProbe | null>();
  const notes: string[] = [];
  refused.forEach((p, i) => {
    const item = again.results[i];
    const verdict = item ? judgeProbe(p, base, { status: item.res.status, text: item.res.text, headers: item.res.headers }) : null;
    verdicts.set(p.token, verdict);
    if (verdict && !verdict.blocked) notes.push(`${p.token} was refused once and got through the second time: not counted`);
  });
  if (again.timedOut) notes.push("Time ran out before every refusal was confirmed: the unconfirmed ones were not counted");
  return {
    probes: first.map((p) => (verdicts.has(p.token) ? verdicts.get(p.token) : p)).filter((p): p is BotProbe => p != null),
    undecided: refused.filter((p) => !verdicts.get(p.token)).map((p) => p.token),
    notes,
  };
}

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

export type LlmsQuality = "missing" | "invalid" | "basic" | "good";

export interface LlmsTxtResult {
  url: string;
  status: number;
  present: boolean;
  quality: LlmsQuality;
  title: string | null;
  summary: boolean;
  sections: number;
  links: Array<{ title: string; url: string }>;
  problems: string[];
}

/** Parse the llms.txt convention (llmstxt.org): an H1, a blockquote summary, H2 sections of markdown links. */
export function parseLlmsTxt(text: string, status: number, url: string, siteOrigin: string): LlmsTxtResult {
  const base: LlmsTxtResult = { url, status, present: false, quality: "missing", title: null, summary: false, sections: 0, links: [], problems: [] };
  if (status < 200 || status >= 300) return base;
  const body = text.trim();
  if (!body) return { ...base, quality: "invalid", problems: ["llms.txt is empty"] };
  // A single-page app often answers every path with its index page and a 200: that is not an llms.txt.
  if (/^\s*<(!doctype|html|head|body)\b/i.test(body)) return { ...base, quality: "invalid", problems: ["the address returns a web page, not a text file (the site answers every path with its home page)"] };
  const lines = body.split(/\r?\n/);
  const title = lines.map((l) => /^#\s+(.+)$/.exec(l.trim())?.[1]?.trim() ?? null).find((t) => t) ?? null;
  const summary = lines.some((l) => /^>\s*\S/.test(l.trim()));
  const sections = lines.filter((l) => /^##\s+\S/.test(l.trim())).length;
  const links: LlmsTxtResult["links"] = [];
  for (const match of body.matchAll(/\[([^\]]+)\]\((\S+?)\)/g)) {
    const href = match[2]!.replace(/[)>,.]+$/, "");
    try {
      links.push({ title: match[1]!.trim(), url: new URL(href, siteOrigin).toString() });
    } catch {
      // not a URL: ignored
    }
  }
  const problems: string[] = [];
  if (!title) problems.push("no title line (# Name of the business)");
  if (!summary) problems.push("no one-line summary under the title (> what the business does)");
  if (sections === 0) problems.push("no ## sections grouping the links");
  if (links.length === 0) problems.push("no links to the site's key pages");
  else if (links.length < 3) problems.push("fewer than 3 links: list the pages an assistant should read first");
  const quality: LlmsQuality = !title || links.length === 0 ? "invalid" : problems.length === 0 ? "good" : "basic";
  return { ...base, present: true, quality, title, summary, sections, links, problems };
}

export function llmsFindings(result: LlmsTxtResult, siteHost: string | null): CheckFinding[] {
  const add = (severity: FindingSeverity, finding: string): CheckFinding => ({ category: "geo", severity, url: result.url, finding });
  if (result.quality === "missing") return [add("low", "No llms.txt (an optional, unproven convention: a short list of the site's key pages for AI tools; cheap to add)")];
  if (result.quality === "invalid") return [add("low", `llms.txt is not usable: ${result.problems.join("; ") || "no title and no links"}`)];
  const out = result.problems.map((p) => add("info", `llms.txt: ${p}`));
  const foreign = siteHost ? result.links.filter((l) => new URL(l.url).hostname.replace(/^www\./, "") !== siteHost.replace(/^www\./, "")).length : 0;
  if (result.links.length > 0 && foreign / result.links.length > 0.5) out.push(add("low", "Most llms.txt links point to other sites: list the business's own key pages"));
  return out;
}

// ---------------------------------------------------------------------------
// Entity: who the business is (Organization / LocalBusiness data)
// ---------------------------------------------------------------------------

const ORG_TYPE = /Organization|Corporation|Business|Service|Store|Shop|Clinic|Dentist|Physician|Hospital|Hotel|Lodging|Restaurant|Cafe|Agency|Firm|Club|School|University|Plumber|Electrician|Contractor|Realtor|RealEstate|Bank|Gym|HealthClub|Salon/;
const NOT_ORG = new Set(["Service", "WebSite", "WebPage", "Product", "Offer", "PostalAddress", "ContactPoint", "Review", "Article", "BlogPosting"]);

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  return typeof t === "string" ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

function isOrgNode(node: Record<string, unknown>): boolean {
  return typesOf(node).some((t) => ORG_TYPE.test(t) && !NOT_ORG.has(t));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function imageUrl(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return imageUrl(value[0]);
  if (value && typeof value === "object") return text((value as Record<string, unknown>).url) || text((value as Record<string, unknown>).contentUrl);
  return "";
}

export type ProfileKind = "linkedin" | "facebook" | "instagram" | "x" | "youtube" | "tiktok" | "pinterest" | "github" | "wikipedia" | "wikidata" | "crunchbase" | "google_maps" | "trustpilot" | "hellopeter" | "other";

const PROFILE_HOSTS: Array<[RegExp, ProfileKind]> = [
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)facebook\.com$|^fb\.com$/, "facebook"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)(x|twitter)\.com$/, "x"],
  [/(^|\.)youtube\.com$|^youtu\.be$/, "youtube"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)pinterest\.[a-z.]+$/, "pinterest"],
  [/(^|\.)github\.com$/, "github"],
  [/(^|\.)wikipedia\.org$/, "wikipedia"],
  [/(^|\.)wikidata\.org$/, "wikidata"],
  [/(^|\.)crunchbase\.com$/, "crunchbase"],
  [/(^|\.)maps\.google\.[a-z.]+$|^goo\.gl$|^g\.page$/, "google_maps"],
  [/(^|\.)trustpilot\.com$/, "trustpilot"],
  [/(^|\.)hellopeter\.com$/, "hellopeter"],
];

export function profileKind(url: string): ProfileKind {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PROFILE_HOSTS.find(([re]) => re.test(host))?.[1] ?? "other";
  } catch {
    return "other";
  }
}

export interface EntityCheck {
  key: string;
  label: string;
  weight: number;
  /** 0 to 1 of the weight earned. */
  earned: number;
  detail: string | null;
}

export interface EntityResult {
  found: boolean;
  types: string[];
  id: string | null;
  name: string | null;
  sameAs: string[];
  /** The phone number the organisation data shows (for checking listings). */
  phone: string | null;
  /** 0 to 100 (0 when there is no organisation data to score). */
  score: number;
  checks: EntityCheck[];
}

/**
 * Score the organisation data a page's JSON-LD gives an AI system. `needsAddress`: local and professional businesses
 * (and shops) are expected to show an address; software is not.
 */
export function entityFromJsonLd(html: string, input: { siteUrl: string; needsAddress: boolean }): EntityResult {
  const nodes = jsonLdNodes(html);
  const orgs = nodes.filter(isOrgNode);
  const none: EntityResult = { found: false, types: [], id: null, name: null, sameAs: [], phone: null, score: 0, checks: [] };
  if (orgs.length === 0) return none;
  const host = hostOf(input.siteUrl);
  const sameHost = (u: string) => hostOf(u) === host;
  const primary = [...orgs].sort((a, b) => Number(sameHost(text(b.url))) - Number(sameHost(text(a.url))) || Object.keys(b).length - Object.keys(a).length)[0]!;
  const sameAs = [...new Set((Array.isArray(primary.sameAs) ? primary.sameAs : primary.sameAs ? [primary.sameAs] : []).map(text).filter((u) => /^https?:\/\//i.test(u)))];
  const address = primary.address && typeof primary.address === "object" ? (primary.address as Record<string, unknown>) : null;
  const contactPoint = Array.isArray(primary.contactPoint) ? primary.contactPoint[0] : primary.contactPoint;
  const contact = contactPoint && typeof contactPoint === "object" ? (contactPoint as Record<string, unknown>) : null;
  const website = nodes.find((n) => typesOf(n).includes("WebSite"));
  const checks: EntityCheck[] = [];
  const check = (key: string, label: string, weight: number, earned: number, detail: string | null = null) => checks.push({ key, label, weight, earned, detail });
  check("name", "Business name", 10, text(primary.name) ? 1 : 0);
  const url = text(primary.url);
  check("url", "Website address", 10, !url ? 0 : sameHost(url) ? 1 : 0.5, url && !sameHost(url) ? `url is ${url}, not this site` : null);
  check("logo", "Logo", 10, imageUrl(primary.logo) || imageUrl(primary.image) ? 1 : 0);
  const description = text(primary.description);
  check("description", "Description of the business", 10, description.length >= 50 ? 1 : description ? 0.5 : 0, description && description.length < 50 ? "under 50 characters" : null);
  check("sameAs", "Links to the business's real profiles (sameAs)", 25, sameAs.length >= 3 ? 1 : sameAs.length === 2 ? 0.72 : sameAs.length === 1 ? 0.32 : 0, `${sameAs.length} profile link${sameAs.length === 1 ? "" : "s"}`);
  const hasContact = Boolean(text(primary.telephone) || text(primary.email) || (contact && (text(contact.telephone) || text(contact.email))));
  check("contact", "Phone or email", 15, hasContact ? 1 : 0);
  if (input.needsAddress) {
    const full = Boolean(address && (text(address.streetAddress) || text(address.addressLocality)) && text(address.addressCountry));
    check("address", "Postal address", 10, full ? 1 : address ? 0.5 : 0, address && !full ? "needs the town and country" : null);
  }
  check("id", "Stable @id", 5, text(primary["@id"]) ? 1 : 0);
  check("website", "WebSite data tied to the business", 5, website && text(website.name) && text(website.url) ? 1 : 0);
  const possible = checks.reduce((sum, c) => sum + c.weight, 0);
  const earned = checks.reduce((sum, c) => sum + c.weight * c.earned, 0);
  const phone = text(primary.telephone) || (contact ? text(contact.telephone) : "") || null;
  return { found: true, types: typesOf(primary), id: text(primary["@id"]) || null, name: text(primary.name) || null, sameAs, phone, score: Math.round((100 * earned) / possible), checks };
}

export function entityFindings(entity: EntityResult, url: string): CheckFinding[] {
  const add = (severity: FindingSeverity, finding: string): CheckFinding => ({ category: "geo", severity, url, finding });
  if (!entity.found) return [add("medium", "No Organization or LocalBusiness data on the home page: AI systems have no machine-readable statement of who the business is (add it as JSON-LD)")];
  const out: CheckFinding[] = [];
  for (const c of entity.checks) {
    if (c.earned >= 1) continue;
    const sev: FindingSeverity = c.key === "sameAs" ? (entity.sameAs.length === 0 ? "medium" : "low") : c.key === "name" || c.key === "url" || c.key === "contact" ? "medium" : "low";
    out.push(add(sev, `Organization data: ${c.label[0]!.toLowerCase()}${c.label.slice(1)} ${c.earned === 0 ? "is missing" : "is incomplete"}${c.detail ? ` (${c.detail})` : ""}`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Answer blocks and FAQ coverage
// ---------------------------------------------------------------------------

export interface AnswerPage {
  url: string;
  words: number;
  questionHeadings: number;
  /** Question headings followed by a short paragraph (12 to 90 words) that answers it. */
  directAnswers: number;
  faqSchemaQuestions: number;
  /** Whether the FAQ markup's questions are on the page (null without FAQ markup). Markup for text the page does not show breaks Google's rules. */
  faqMatchesPage: boolean | null;
  answerReady: boolean;
}

const QUESTION_START = /^(what|why|how|when|where|who|which|can|could|do|does|did|is|are|was|should|will|would|am|may)\b/i;

function plain(html: string): string {
  return html.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<[^>]+>/gi, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function wordCount(value: string): number {
  return value ? value.split(/\s+/).length : 0;
}

export function analyseAnswerBlocks(html: string, url: string): AnswerPage {
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  const headings = [...body.matchAll(/<(h[2-4])\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  let questionHeadings = 0;
  let directAnswers = 0;
  headings.forEach((match, index) => {
    const label = plain(match[2]!);
    if (label.length < 8 || label.length > 160 || !(label.endsWith("?") || QUESTION_START.test(label))) return;
    questionHeadings += 1;
    const start = match.index! + match[0].length;
    const end = headings[index + 1]?.index ?? Math.min(body.length, start + 3000);
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(body.slice(start, Math.min(end, start + 3000)));
    const words = paragraph ? wordCount(plain(paragraph[1]!)) : 0;
    if (words >= 12 && words <= 90) directAnswers += 1;
  });
  const faq = jsonLdNodes(html).filter((n) => typesOf(n).includes("FAQPage"));
  const questions = faq.flatMap((n) => (Array.isArray(n.mainEntity) ? n.mainEntity : n.mainEntity ? [n.mainEntity] : []))
    .map((q) => text((q as Record<string, unknown> | null)?.name))
    .filter(Boolean);
  const pageText = bodyText(html).toLowerCase();
  const sample = questions.slice(0, 5);
  const shown = sample.filter((q) => pageText.includes(q.toLowerCase().replace(/\s+/g, " ")));
  const faqMatchesPage = questions.length === 0 ? null : shown.length / sample.length >= 0.6;
  const faqUsable = questions.length >= 3 && faqMatchesPage !== false;
  return {
    url,
    words: wordCount(bodyText(html)),
    questionHeadings,
    directAnswers,
    faqSchemaQuestions: questions.length,
    faqMatchesPage,
    answerReady: directAnswers >= 2 || faqUsable,
  };
}

export function answerFindings(pages: AnswerPage[]): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const page of pages) {
    const add = (severity: FindingSeverity, finding: string) => out.push({ category: "geo", severity, url: page.url, finding });
    if (page.faqMatchesPage === false) add("medium", "FAQ markup lists questions the page does not show: remove the markup or show the questions (Google ignores hidden FAQ markup)");
    if (!page.answerReady) {
      add("low", page.questionHeadings === 0
        ? "No question headings with a short direct answer under them: AI answers quote text that answers a question in 2 to 3 sentences"
        : `${page.questionHeadings} question heading${page.questionHeadings === 1 ? "" : "s"} but fewer than 2 are followed by a short direct answer (12 to 90 words)`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snippet limits in robots directives
// ---------------------------------------------------------------------------

export function snippetFindings(url: string, directives: string | null): { findings: CheckFinding[]; limited: "none" | "noai" | "nosnippet" } {
  const d = (directives ?? "").toLowerCase();
  const findings: CheckFinding[] = [];
  const maxSnippet = /max-snippet\s*:\s*(-?\d+)/.exec(d);
  const noSnippet = /\bnosnippet\b/.test(d) || (maxSnippet !== null && Number(maxSnippet[1]) >= 0 && Number(maxSnippet[1]) < 50);
  if (noSnippet) findings.push({ category: "geo", severity: "medium", url, finding: "The page's robots directives forbid or cut text snippets (nosnippet or a tiny max-snippet): search and AI answers cannot quote it" });
  const noAi = /\bnoai\b|\bnoimageai\b/.test(d);
  if (noAi) findings.push({ category: "geo", severity: "low", url, finding: "The page asks AI systems not to use it (noai / noimageai)" });
  return { findings, limited: noSnippet ? "nosnippet" : noAi ? "noai" : "none" };
}

// ---------------------------------------------------------------------------
// Brand consistency (profiles and directories)
// ---------------------------------------------------------------------------

const LEGAL_SUFFIX = /\b(pty|ltd|limited|inc|llc|cc|npc|proprietary|\(pty\)|\(ltd\))\b/g;

export function normaliseBrand(value: string): string {
  return value.toLowerCase().replace(/&amp;|&/g, " and ").replace(LEGAL_SUFFIX, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Whether the page names the business (any of its names, ignoring case, punctuation and "(Pty) Ltd"). */
export function mentionsBrand(pageText: string, names: string[]): boolean {
  const hay = ` ${normaliseBrand(pageText)} `;
  return names.map(normaliseBrand).filter((n) => n.length >= 3).some((n) => hay.includes(` ${n} `));
}

function digits(value: string): string {
  return value.replace(/\D+/g, "");
}

/** Whether the page shows the phone number (compared on its last 9 digits, so +27 31 … and 031 … match). null without a number to compare. */
export function mentionsPhone(pageText: string, phone: string | null | undefined): boolean | null {
  const wanted = phone ? digits(phone).slice(-9) : "";
  if (wanted.length < 7) return null;
  return digits(pageText).includes(wanted);
}

export type SameAsState = "match" | "no-match" | "unverifiable" | "broken";

export interface SameAsCheck {
  url: string;
  kind: ProfileKind;
  status: number | null;
  state: SameAsState;
}

/** Sites that refuse unknown clients or need a login: a refusal there says nothing about the profile. */
const GUARDED_PROFILE = new Set<ProfileKind>(["linkedin", "facebook", "instagram", "x", "tiktok", "pinterest", "google_maps"]);

export function judgeSameAs(url: string, reply: { status: number; text: string } | null, names: string[]): SameAsCheck {
  const kind = profileKind(url);
  if (!reply) return { url, kind, status: null, state: "unverifiable" };
  if (reply.status === 404 || reply.status === 410) return { url, kind, status: reply.status, state: "broken" };
  if (reply.status >= 500) return { url, kind, status: reply.status, state: "unverifiable" };
  if (reply.status >= 400) return { url, kind, status: reply.status, state: GUARDED_PROFILE.has(kind) ? "unverifiable" : "broken" };
  const meta = extractMeta(reply.text);
  const sample = [meta.title, meta.ogTitle, meta.ogDescription, bodyText(reply.text).slice(0, 20_000)].filter(Boolean).join(" ");
  return { url, kind, status: reply.status, state: mentionsBrand(sample, names) ? "match" : GUARDED_PROFILE.has(kind) && sample.length < 300 ? "unverifiable" : "no-match" };
}

export interface DirectoryCheck {
  url: string;
  source: string;
  status: number | null;
  nameFound: boolean | null;
  phoneFound: boolean | null;
}

export function sameAsFindings(checks: SameAsCheck[]): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of checks) {
    if (c.state === "broken") out.push({ category: "geo", severity: "low", url: c.url, finding: `A sameAs profile link does not work${c.status ? ` (HTTP ${c.status})` : ""}: remove it or fix it` });
    else if (c.state === "no-match") out.push({ category: "geo", severity: "low", url: c.url, finding: "The sameAs profile does not show the business name: check it is the right profile and the name matches the site" });
  }
  return out;
}

export function directoryFindings(checks: DirectoryCheck[]): CheckFinding[] {
  const out: CheckFinding[] = [];
  for (const c of checks) {
    if (c.status != null && c.status >= 400) out.push({ category: "geo", severity: "low", url: c.url, finding: `The ${c.source} listing no longer loads (HTTP ${c.status})` });
    else if (c.nameFound === false) out.push({ category: "geo", severity: "medium", url: c.url, finding: `The ${c.source} listing does not show the business name the site uses: AI systems cross-check these listings, so the name must match everywhere` });
    else if (c.phoneFound === false) out.push({ category: "geo", severity: "medium", url: c.url, finding: `The ${c.source} listing does not show the phone number the site uses` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

export const GEO_SECTIONS = ["crawlers", "entity", "answers", "brand", "llms", "snippets"] as const;
export type GeoSection = (typeof GEO_SECTIONS)[number];

export const GEO_WEIGHTS: Record<GeoSection, number> = { crawlers: 30, entity: 25, answers: 20, brand: 15, llms: 5, snippets: 5 };

export interface SectionScore {
  earned: number;
  possible: number;
  /** False when the check could not run (the page or file did not load, or time ran out): it is left out, not counted as a failure. */
  evaluated: boolean;
}

export type GeoBand = "strong" | "good" | "fair" | "weak";

export function geoBand(score: number): GeoBand {
  return score >= 85 ? "strong" : score >= 65 ? "good" : score >= 40 ? "fair" : "weak";
}

export function geoScore(sections: Record<GeoSection, SectionScore>): { score: number; band: GeoBand; complete: boolean; breakdown: Record<GeoSection, SectionScore> } {
  const parts = GEO_SECTIONS.map((s) => sections[s]).filter((s) => s.evaluated && s.possible > 0);
  const possible = parts.reduce((sum, s) => sum + s.possible, 0);
  const earned = parts.reduce((sum, s) => sum + s.earned, 0);
  const score = possible > 0 ? Math.round((100 * earned) / possible) : 0;
  return { score, band: geoBand(score), complete: GEO_SECTIONS.every((s) => sections[s].evaluated), breakdown: sections };
}

/** A section that could not be checked: left out of the score, never counted as a failure. */
function skipped(section: GeoSection): SectionScore {
  return { earned: 0, possible: GEO_WEIGHTS[section], evaluated: false };
}

export function crawlersSection(access: BotAccess[], probes: BotProbe[]): SectionScore {
  const search = access.filter((a) => a.kind === "search");
  const user = access.filter((a) => a.kind === "user");
  const refused = new Set(probes.filter((p) => p.blocked).map((p) => p.token));
  const value = (a: BotAccess) => (refused.has(a.token) ? 0 : a.state === "allowed" ? 1 : a.state === "partial" ? 0.5 : 0);
  const searchShare = search.length ? search.reduce((s, a) => s + value(a), 0) / search.length : 1;
  const userShare = user.length ? user.reduce((s, a) => s + value(a), 0) / user.length : 1;
  return { earned: Math.round((24 * searchShare + 6 * userShare) * 10) / 10, possible: GEO_WEIGHTS.crawlers, evaluated: true };
}

export function entitySection(entity: EntityResult | null): SectionScore {
  if (!entity) return skipped("entity");
  return { earned: Math.round(((entity.score * GEO_WEIGHTS.entity) / 100) * 10) / 10, possible: GEO_WEIGHTS.entity, evaluated: true };
}

export function answersSection(pages: AnswerPage[]): SectionScore {
  if (pages.length === 0) return skipped("answers");
  const ready = pages.filter((p) => p.answerReady).length;
  return { earned: Math.round(((GEO_WEIGHTS.answers * ready) / pages.length) * 10) / 10, possible: GEO_WEIGHTS.answers, evaluated: true };
}

/** Profiles (7 points) and directory listings (8 points); a part with nothing to check is left out. */
export function brandSection(sameAs: SameAsCheck[], directories: DirectoryCheck[]): SectionScore {
  let earned = 0;
  let possible = 0;
  if (sameAs.length > 0) {
    possible += 7;
    earned += (7 * sameAs.reduce((s, c) => s + (c.state === "match" ? 1 : c.state === "unverifiable" ? 0.5 : 0), 0)) / sameAs.length;
  }
  const loaded = directories.filter((d) => d.status != null && d.status < 400);
  if (directories.length > 0) {
    possible += 8;
    const consistent = loaded.filter((d) => d.nameFound !== false && d.phoneFound !== false).length;
    earned += (8 * consistent) / directories.length;
  }
  return { earned: Math.round(earned * 10) / 10, possible: possible || GEO_WEIGHTS.brand, evaluated: possible > 0 };
}

export function llmsSection(result: LlmsTxtResult | null): SectionScore {
  if (!result) return skipped("llms");
  const earned = result.quality === "good" ? 5 : result.quality === "basic" ? 3 : result.quality === "invalid" ? 1 : 0;
  return { earned, possible: GEO_WEIGHTS.llms, evaluated: true };
}

export function snippetsSection(limited: "none" | "noai" | "nosnippet" | null): SectionScore {
  if (limited == null) return skipped("snippets");
  return { earned: limited === "none" ? 5 : limited === "noai" ? 3 : 0, possible: GEO_WEIGHTS.snippets, evaluated: true };
}

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

export interface GeoAuditInput {
  siteUrl: string;
  /** Local, professional and ecommerce businesses are expected to show an address. */
  needsAddress: boolean;
  /** Names the business goes by (site name, client name, the name in its schema): any one matching counts. */
  brandNames: string[];
  /** Pages to sample for answer blocks; default: the home page plus up to 5 (the sprint's own pages first, then the sitemap's). */
  pages?: string[];
  /** The pages the sprint works on (live content and keyword targets): sampled first when `pages` is not given. */
  preferredPages?: string[];
  /** Live directory and citation listings (their URLs) to cross-check. */
  directories?: Array<{ url: string; source: string }>;
  /** The phone number the site shows, for the listing check. */
  phone?: string | null;
  deadlineMs?: number;
  /**
   * Send each AI search bot's user agent to the site to see whether a firewall refuses it (default true). The probes
   * come from this server's address, so they are for the sprint's own site only: an audit of any other site skips them.
   */
  probe?: boolean;
}

/** A resource an audit looked at, so a re-run can close what it no longer reports there. */
export interface CoveredResource {
  category: string;
  url: string | null;
  /** Findings on this resource that this run could not re-judge (a check that did not finish): kept open, not closed. */
  keepOpen?: (finding: string) => boolean;
}

export interface GeoAuditResult {
  siteUrl: string;
  score: number;
  band: GeoBand;
  /** False when a check could not run: the score covers the checks that did. */
  complete: boolean;
  breakdown: Record<GeoSection, SectionScore>;
  crawlers: BotAccess[];
  serverProbes: BotProbe[];
  llms: LlmsTxtResult | null;
  entity: EntityResult | null;
  answers: AnswerPage[];
  sameAs: SameAsCheck[];
  directories: DirectoryCheck[];
  snippets: "none" | "noai" | "nosnippet" | null;
  pagesChecked: string[];
  findings: CheckFinding[];
  /**
   * Resources whose check actually ran, so a re-run can close what it no longer reports there. A file, page or profile
   * that did not answer (a timeout, a server error) is not listed: its open findings stay open until a check runs.
   */
  covered: CoveredResource[];
  notes: string[];
}

const PAGE_HINT = /\/(services?|about|contact|faqs?|pricing|products?|shop|blog|areas?|team|rooms?|treatments?|practice|solutions?)\b/i;

/** The home page plus up to 5 more: the pages the sprint works on (`preferred`, at most 3), then the sitemap's pages customers read first. */
export function pickSamplePages(home: string, sitemapUrls: string[], max = 6, preferred: string[] = []): string[] {
  const seen = new Set<string>([home]);
  const out = [home];
  const ranked = [...preferred.slice(0, 3), ...sitemapUrls.filter((u) => PAGE_HINT.test(u)), ...sitemapUrls];
  for (const url of ranked) {
    if (out.length >= max) break;
    const key = url.replace(/\/+$/, "");
    if (seen.has(key) || seen.has(`${key}/`)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

async function sitemapSample(fetcher: SiteFetcher, siteUrl: string, robots: ParsedRobots | null): Promise<string[]> {
  const candidates = [...(robots?.sitemaps ?? []).slice(0, 1), `${originOf(siteUrl)}/sitemap.xml`];
  for (const candidate of candidates) {
    try {
      const res = await fetcher(candidate, { maxChars: 2_000_000 });
      if (res.status >= 400) continue;
      let parsed = parseSitemap(res.text);
      if (parsed.kind === "index" && parsed.sitemaps[0]) parsed = parseSitemap((await fetcher(new URL(parsed.sitemaps[0], candidate).toString(), { maxChars: 2_000_000 })).text);
      if (parsed.urls.length > 0) return parsed.urls.slice(0, 200);
    } catch {
      // try the next candidate
    }
  }
  return [];
}

/** Run every GEO check on a site. Never throws for a site that does not answer: the unanswered check is left out of the score and said in `notes`. */
export async function runGeoAudit(fetcher: SiteFetcher, input: GeoAuditInput): Promise<GeoAuditResult> {
  const deadlineAt = Date.now() + (input.deadlineMs ?? 22_000);
  const origin = originOf(input.siteUrl);
  const home = `${origin}/`;
  const host = hostOf(origin);
  const notes: string[] = [];
  const findings: CheckFinding[] = [];
  // A resource is covered only when its check ran: a file or page that did not answer must not close what was found there.
  const covered: CoveredResource[] = [];
  const cover = (url: string, keepOpen?: CoveredResource["keepOpen"]) => covered.push({ category: "geo", url, ...(keepOpen ? { keepOpen } : {}) });
  const attempt = async <T>(label: string, run: () => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (error) {
      notes.push(`${label} could not be checked (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  };

  // 1. The files and the home page.
  const [robotsRes, llmsRes, homeRes] = await Promise.all([
    attempt("robots.txt", () => fetcher(`${origin}/robots.txt`, { maxChars: 200_000 })),
    attempt("llms.txt", () => fetcher(`${origin}/llms.txt`, { maxChars: 200_000 })),
    attempt("The home page", () => fetcher(home, { headers: { Accept: "text/html,application/xhtml+xml" }, maxChars: 800_000 })),
  ]);
  const robotsOk = robotsRes != null && robotsRes.status < 500;
  const robots = robotsRes && robotsRes.status < 400 ? parseRobots(robotsRes.text) : null;
  if (robotsRes && robotsRes.status >= 500) notes.push(`robots.txt answers HTTP ${robotsRes.status}: crawler access was not scored`);
  if (robotsOk) cover(`${origin}/robots.txt`);
  const llmsOk = llmsRes != null && llmsRes.status < 500;
  if (llmsRes && llmsRes.status >= 500) notes.push(`llms.txt answers HTTP ${llmsRes.status}: it was not scored`);
  if (llmsOk) cover(`${origin}/llms.txt`);
  const homeOk = homeRes != null && homeRes.status < 400;
  if (homeRes && homeRes.status >= 400) notes.push(`The home page answers HTTP ${homeRes.status}: the page checks were not scored`);

  // 2. The pages to sample (answer blocks) and the pages whose paths the crawler rules are tried on.
  const sitemapUrls = input.pages?.length ? [] : await attempt("The sitemap", () => sitemapSample(fetcher, input.siteUrl, robots)) ?? [];
  const pageUrls = input.pages?.length ? [...new Set([home, ...input.pages])].slice(0, 8) : pickSamplePages(home, sitemapUrls, 6, input.preferredPages);
  const samplePaths = [...new Set(pageUrls.map((u) => { try { return new URL(u).pathname || "/"; } catch { return "/"; } }))].slice(0, 6);
  const crawlers = robotsOk ? aiBotAccess(robots, samplePaths) : [];
  if (robotsOk) findings.push(...aiRobotsFindings(crawlers, `${origin}/robots.txt`));

  // 3. Page fetches, server probes with each bot's user agent, llms.txt links, profile and listing checks: in parallel groups, bounded.
  const pageFetch = mapLimit(pageUrls.filter((u) => u !== home), 4, deadlineAt, (url) => fetcher(url, { headers: { Accept: "text/html,application/xhtml+xml" }, maxChars: 800_000 }));
  const probing = homeOk && input.probe !== false;
  const probeFetch = probing
    ? mapLimit([...PROBED_BOTS], 5, deadlineAt, async (token) => ({ token, res: await fetcher(home, { headers: { "User-Agent": botUserAgent(token), Accept: "text/html,*/*" }, maxChars: 4_000 }) }))
    : Promise.resolve({ results: [] as Array<{ token: string; res: Awaited<ReturnType<SiteFetcher>> } | null>, completed: 0, timedOut: false });
  const llms = llmsOk ? parseLlmsTxt(llmsRes!.text, llmsRes!.status, `${origin}/llms.txt`, origin) : null;
  const entityPage = homeOk ? entityFromJsonLd(homeRes!.text, { siteUrl: origin, needsAddress: input.needsAddress }) : null;
  const sameAsUrls = (entityPage?.sameAs ?? []).slice(0, 6);
  const brandNames = [...new Set([...input.brandNames, ...(entityPage?.name ? [entityPage.name] : [])].map((n) => n.trim()).filter(Boolean))];
  const sameAsFetch = mapLimit(sameAsUrls, 5, deadlineAt, (url) => fetcher(url, { headers: { Accept: "text/html,*/*" }, maxChars: 300_000 }));
  const directories = (input.directories ?? []).slice(0, 8);
  const directoryFetch = mapLimit(directories, 5, deadlineAt, (d) => fetcher(d.url, { headers: { Accept: "text/html,*/*" }, maxChars: 300_000 }));
  const [pagesDone, probesDone, sameAsDone, dirsDone] = await Promise.all([pageFetch, probeFetch, sameAsFetch, directoryFetch]);
  if (pagesDone.timedOut || probesDone.timedOut || sameAsDone.timedOut || dirsDone.timedOut) notes.push("Time ran out before every page, profile or listing was fetched: the rest are not counted");

  const answers: AnswerPage[] = [];
  if (homeOk) answers.push(analyseAnswerBlocks(homeRes!.text, home));
  pageUrls.filter((u) => u !== home).forEach((url, i) => {
    const res = pagesDone.results[i];
    if (res && res.status < 400) answers.push(analyseAnswerBlocks(res.text, url));
  });
  findings.push(...answerFindings(answers));
  for (const a of answers) if (a.url !== home) cover(a.url);

  const serverProbes: BotProbe[] = [];
  // Bots whose refusal could not be judged this run (the probe did not finish, or a refusal could not be confirmed):
  // what an earlier audit found about them stays open.
  let unjudged: string[] = [];
  if (probing) {
    const base: Reply = { status: homeRes!.status, text: homeRes!.text, headers: homeRes!.headers };
    const first: BotProbe[] = [];
    for (const item of probesDone.results) {
      if (!item) continue;
      const bot = AI_BOTS.find((b) => b.token === item.token);
      const verdict = judgeProbe({ token: item.token, kind: bot?.kind ?? "training" }, base, { status: item.res.status, text: item.res.text, headers: item.res.headers });
      if (verdict) first.push(verdict);
    }
    const confirmed = await confirmRefusals(fetcher, home, first, deadlineAt);
    serverProbes.push(...confirmed.probes);
    notes.push(...confirmed.notes);
    unjudged = PROBED_BOTS.filter((token) => !serverProbes.some((p) => p.token === token));
    findings.push(...probeFindings(serverProbes, home));
  }
  if (homeOk) cover(home, unjudged.length > 0 ? (finding) => unjudged.some((token) => finding.startsWith(`The server refuses ${token} `)) : undefined);

  if (llms) findings.push(...llmsFindings(llms, host));
  if (llms?.present && llms.links.length > 0) {
    // Does what llms.txt points at load?
    const linked = await mapLimit(llms.links.slice(0, 5), 5, deadlineAt, (l) => fetcher(l.url, { method: "HEAD", maxChars: 0 }));
    linked.results.forEach((res, i) => {
      const link = llms.links[i]!;
      if (!res || res.status >= 500) return; // no answer or a server error: not a verdict on the page
      cover(link.url);
      if (res.status >= 400) findings.push({ category: "geo", severity: "low", url: link.url, finding: `llms.txt lists a page that answers HTTP ${res.status}` });
    });
  }

  let snippets: "none" | "noai" | "nosnippet" | null = null;
  if (homeOk) {
    const meta = extractMeta(homeRes!.text);
    const directives = [meta.robots, meta.googlebot, homeRes!.headers["x-robots-tag"]].filter(Boolean).join(", ");
    const result = snippetFindings(home, directives || null);
    snippets = result.limited;
    findings.push(...result.findings);
  }
  if (entityPage) findings.push(...entityFindings(entityPage, home));

  const sameAs = sameAsUrls.map((url, i) => judgeSameAs(url, sameAsDone.results[i] ? { status: sameAsDone.results[i]!.status, text: sameAsDone.results[i]!.text } : null, brandNames));
  findings.push(...sameAsFindings(sameAs));
  for (const c of sameAs) if (c.state !== "unverifiable") cover(c.url);
  const directoryChecks: DirectoryCheck[] = directories.map((d, i) => {
    const res = dirsDone.results[i];
    if (!res) return { url: d.url, source: d.source, status: null, nameFound: null, phoneFound: null };
    const pageText = bodyText(res.text);
    const phone = input.phone ?? entityPage?.phone ?? null;
    return { url: d.url, source: d.source, status: res.status, nameFound: res.status < 400 ? mentionsBrand(pageText, brandNames) : null, phoneFound: res.status < 400 ? mentionsPhone(pageText, phone) : null };
  }).filter((d) => d.status != null && d.status < 500);
  const unanswered = directories.length - directoryChecks.length;
  if (unanswered > 0) notes.push(`${unanswered} listing${unanswered === 1 ? "" : "s"} did not answer (no reply or a server error): not counted`);
  findings.push(...directoryFindings(directoryChecks));
  for (const d of directoryChecks) cover(d.url);

  const scored = geoScore({
    crawlers: robotsOk ? crawlersSection(crawlers, serverProbes) : skipped("crawlers"),
    entity: entitySection(entityPage),
    answers: answersSection(answers),
    brand: brandSection(sameAs, directoryChecks),
    llms: llmsSection(llms),
    snippets: snippetsSection(snippets),
  });
  return {
    siteUrl: origin,
    score: scored.score,
    band: scored.band,
    complete: scored.complete,
    breakdown: scored.breakdown,
    crawlers,
    serverProbes,
    llms,
    entity: entityPage,
    answers,
    sameAs,
    directories: directoryChecks,
    snippets,
    pagesChecked: answers.map((a) => a.url),
    findings,
    covered,
    notes,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}
