/**
 * GEO rules that need no network: the AI answers an agent sampled (validated so a mention cannot be made up), the
 * rate and trend they give, the queries worth sampling, the compact form of an audit for storage, and how the
 * score changed. Pure.
 *
 * Nothing here calls an AI provider. The plugin has no account with any of them and never invents a result: the
 * agent samples what its own tools can reach, and the plugin records exactly that.
 */
import { AI_BOTS, type AiBotKind, type GeoAuditResult, type GeoBand, type GeoSection, type SectionScore } from "../checks/geo.js";

export const AI_ENGINES = ["chatgpt", "perplexity", "gemini", "google_ai_overview", "copilot", "claude", "search_tool", "other"] as const;
export type AiEngine = (typeof AI_ENGINES)[number];

export const ENGINE_LABELS: Record<AiEngine, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  google_ai_overview: "Google AI Overview",
  copilot: "Copilot",
  claude: "Claude",
  search_tool: "the agent's web search",
  other: "another assistant",
};

export interface MentionSample {
  query: string;
  engine: AiEngine;
  sampledOn: string;
  /** The answer names the business. */
  mentioned: boolean;
  /** The answer lists a page of the site as a source. */
  cited: boolean;
  /** Where the business sits in the answer when it lists several (1 = first). */
  position: number | null;
  citedUrls: string[];
  competitors: string[];
  /** A short quote from the answer that shows the mention. */
  evidence: string | null;
  note: string | null;
  /** How the answer was obtained, e.g. "Claude web search tool". */
  method: string | null;
}

export const MAX_SAMPLES_PER_CALL = 40;

export function queryKey(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : null;
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

/**
 * Validate the samples an agent sends. A sample that says the business was mentioned or cited must carry what shows
 * it (a quote, or the source URLs, one of them on the site): an unproven mention is refused, not recorded.
 */
export function parseMentionSamples(raw: unknown, input: { today: string; siteHost: string }): { samples: MentionSample[]; errors: string[] } {
  const errors: string[] = [];
  const samples: MentionSample[] = [];
  if (!Array.isArray(raw) || raw.length === 0) return { samples, errors: ["samples must be a list with at least one sampled answer"] };
  if (raw.length > MAX_SAMPLES_PER_CALL) errors.push(`At most ${MAX_SAMPLES_PER_CALL} samples per call (got ${raw.length}); send the rest in a second call.`);
  raw.slice(0, MAX_SAMPLES_PER_CALL).forEach((item, i) => {
    const at = `Sample ${i + 1}`;
    if (!item || typeof item !== "object") return errors.push(`${at} is not an object`);
    const s = item as Record<string, unknown>;
    const query = clip(s.query, 200);
    if (!query || query.length < 3) return errors.push(`${at}: query is required (the question you asked, at least 3 characters)`);
    const engine = typeof s.engine === "string" ? s.engine : "";
    if (!(AI_ENGINES as readonly string[]).includes(engine)) return errors.push(`${at}: engine must be one of ${AI_ENGINES.join(", ")}`);
    const mentioned = asBool(s.mentioned);
    if (mentioned == null) return errors.push(`${at}: mentioned must be true or false (did the answer name the business?)`);
    const cited = asBool(s.cited) ?? false;
    const citedUrls = (Array.isArray(s.citedUrls) ? s.citedUrls : []).filter((u): u is string => typeof u === "string").map((u) => u.trim()).filter(Boolean).slice(0, 10);
    const evidence = clip(s.evidence, 400);
    if ((mentioned || cited) && !evidence && citedUrls.length === 0) return errors.push(`${at}: a mention or citation needs evidence (a short quote from the answer) or citedUrls that show it; nothing is recorded without it`);
    if (cited && input.siteHost && !citedUrls.some((u) => hostOf(u) === input.siteHost)) return errors.push(`${at}: cited is true but none of citedUrls is a page on ${input.siteHost}`);
    const sampledOn = typeof s.sampledOn === "string" && s.sampledOn ? s.sampledOn.slice(0, 10) : input.today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sampledOn) || Number.isNaN(Date.parse(`${sampledOn}T00:00:00Z`))) return errors.push(`${at}: sampledOn must be a date like 2026-10-01`);
    if (sampledOn > input.today) return errors.push(`${at}: sampledOn is in the future`);
    const position = typeof s.position === "number" && Number.isInteger(s.position) && s.position >= 1 && s.position <= 20 ? s.position : null;
    const competitors = [...new Set((Array.isArray(s.competitors) ? s.competitors : []).map((c) => clip(c, 80)).filter((c): c is string => Boolean(c)))].slice(0, 10);
    samples.push({ query, engine: engine as AiEngine, sampledOn, mentioned, cited, position, citedUrls, competitors, evidence, note: clip(s.note, 400), method: clip(s.method, 120) });
  });
  return { samples, errors };
}

export interface StoredMention {
  query: string;
  engine: string;
  sampledOn: string;
  mentioned: boolean;
  cited: boolean;
  competitors: string[];
}

export interface MentionStats {
  /** Distinct (question, assistant) pairs, each counted once at its latest sample. */
  sampled: number;
  questions: number;
  mentioned: number;
  cited: number;
  /** Mentioned or cited. */
  visible: number;
  /** visible / sampled, 0 to 1; null when nothing was sampled. */
  rate: number | null;
  byEngine: Record<string, { sampled: number; visible: number }>;
  topCompetitors: Array<{ name: string; count: number }>;
  lastSampledOn: string | null;
}

/** The latest sample of each question on each assistant: sampling again replaces the old answer, it does not add to it. */
export function latestSamples<T extends Pick<StoredMention, "query" | "engine" | "sampledOn">>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = `${queryKey(row.query)}|${row.engine}`;
    const kept = latest.get(key);
    if (!kept || row.sampledOn > kept.sampledOn) latest.set(key, row);
  }
  return [...latest.values()];
}

export function mentionStats(rows: StoredMention[]): MentionStats {
  const latest = latestSamples(rows);
  const byEngine: MentionStats["byEngine"] = {};
  const competitors = new Map<string, number>();
  let mentioned = 0;
  let cited = 0;
  let visible = 0;
  for (const row of latest) {
    const seen = row.mentioned || row.cited;
    mentioned += row.mentioned ? 1 : 0;
    cited += row.cited ? 1 : 0;
    visible += seen ? 1 : 0;
    const e = (byEngine[row.engine] ??= { sampled: 0, visible: 0 });
    e.sampled += 1;
    e.visible += seen ? 1 : 0;
    for (const name of row.competitors) competitors.set(name, (competitors.get(name) ?? 0) + 1);
  }
  return {
    sampled: latest.length,
    questions: new Set(latest.map((r) => queryKey(r.query))).size,
    mentioned,
    cited,
    visible,
    rate: latest.length > 0 ? Math.round((visible / latest.length) * 1000) / 1000 : null,
    byEngine,
    topCompetitors: [...competitors.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([name, count]) => ({ name, count })),
    lastSampledOn: latest.reduce<string | null>((max, r) => (max == null || r.sampledOn > max ? r.sampledOn : max), null),
  };
}

export interface MentionTrend {
  baseline: { on: string; sampled: number; rate: number } | null;
  latest: { on: string; sampled: number; rate: number } | null;
  /** Percentage points, latest minus baseline (null until two different days each have at least `minSamples`). */
  changePoints: number | null;
}

/** Rate on each day answers were sampled (a day needs at least `minSamples` to count), first day against the latest. */
export function mentionTrend(rows: StoredMention[], minSamples = 3): MentionTrend {
  const days = new Map<string, StoredMention[]>();
  for (const row of rows) (days.get(row.sampledOn) ?? days.set(row.sampledOn, []).get(row.sampledOn)!).push(row);
  const rated = [...days.entries()]
    .filter(([, list]) => list.length >= minSamples)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([on, list]) => ({ on, sampled: list.length, rate: Math.round((list.filter((r) => r.mentioned || r.cited).length / list.length) * 1000) / 1000 }));
  const baseline = rated[0] ?? null;
  const latest = rated.length > 1 ? rated[rated.length - 1]! : null;
  return { baseline, latest, changePoints: baseline && latest ? Math.round((latest.rate - baseline.rate) * 1000) / 10 : null };
}

/** Questions worth sampling: the sprint's priority keywords, then the ones about the business itself. At most 10. */
export function suggestAiQueries(input: { siteName: string; keywords: Array<{ phrase: string; isPriority: boolean; intent: string | null }> }): string[] {
  const brandWords = input.siteName.toLowerCase();
  const own = (phrase: string) => phrase.toLowerCase().includes(brandWords);
  const picked = [...input.keywords.filter((k) => k.isPriority), ...input.keywords.filter((k) => !k.isPriority && k.intent !== "brand")].map((k) => k.phrase).filter((p) => !own(p));
  const out: string[] = [];
  for (const phrase of picked) if (out.length < 7 && !out.some((o) => queryKey(o) === queryKey(phrase))) out.push(phrase);
  for (const q of [`${input.siteName} reviews`, `who is ${input.siteName}`, `is ${input.siteName} any good`]) if (out.length < 10) out.push(q);
  return out;
}

// ---------------------------------------------------------------------------
// The audit, stored and summarised
// ---------------------------------------------------------------------------

/** What is kept of an audit: the evidence behind each section, not the pages. */
export function compactGeo(result: GeoAuditResult) {
  return {
    crawlers: result.crawlers.map((c) => ({ token: c.token, kind: c.kind, state: c.state, via: c.via })),
    serverProbes: result.serverProbes.map((p) => ({ token: p.token, kind: p.kind, status: p.status, blocked: p.blocked })),
    llms: result.llms ? { quality: result.llms.quality, links: result.llms.links.length, problems: result.llms.problems } : null,
    entity: result.entity ? { found: result.entity.found, score: result.entity.score, types: result.entity.types, sameAs: result.entity.sameAs.length, missing: result.entity.checks.filter((c) => c.earned < 1).map((c) => c.key) } : null,
    answers: { checked: result.answers.length, ready: result.answers.filter((a) => a.answerReady).length },
    sameAs: result.sameAs.map((s) => ({ kind: s.kind, state: s.state })),
    directories: result.directories.map((d) => ({ source: d.source, status: d.status, nameFound: d.nameFound, phoneFound: d.phoneFound })),
    snippets: result.snippets,
    notes: result.notes,
  };
}

export type GeoSections = ReturnType<typeof compactGeo>;

export interface StoredGeoAudit {
  id: string;
  auditedOn: string;
  score: number;
  band: GeoBand;
  complete: boolean;
  breakdown: Record<GeoSection, SectionScore> | Record<string, never>;
  sections: Partial<GeoSections>;
}

/** What kind of bot a stored probe was (rows stored before the kind was kept are looked up by name; unknown counts as training). */
export function probeKind(probe: { token: string; kind?: AiBotKind }): AiBotKind {
  return probe.kind ?? AI_BOTS.find((b) => b.token === probe.token)?.kind ?? "training";
}

/**
 * Search bots blocked by robots.txt or refused by the server. A training crawler (GPTBot, ClaudeBot ...) is never in
 * this list: blocking those is the client's policy, and AI search can still read the site.
 */
export function blockedSearchBots(sections: Partial<GeoSections> | null): string[] {
  if (!sections) return [];
  const byRobots = (sections.crawlers ?? []).filter((c) => c.kind === "search" && c.state !== "allowed").map((c) => c.token);
  const byServer = (sections.serverProbes ?? []).filter((p) => p.blocked && probeKind(p) !== "training").map((p) => p.token);
  return [...new Set([...byRobots, ...byServer])];
}

export interface GeoChange {
  scoreDelta: number | null;
  /** Search bots that were open at the last audit and are blocked now. */
  newlyBlocked: string[];
  reopened: string[];
}

export function geoChange(previous: Pick<StoredGeoAudit, "score" | "sections"> | null, next: Pick<StoredGeoAudit, "score" | "sections">): GeoChange {
  const before = new Set(blockedSearchBots(previous?.sections ?? null));
  const after = new Set(blockedSearchBots(next.sections));
  return {
    scoreDelta: previous ? next.score - previous.score : null,
    newlyBlocked: previous ? [...after].filter((t) => !before.has(t)) : [],
    reopened: previous ? [...before].filter((t) => !after.has(t)) : [],
  };
}

export interface GeoSnapshot {
  /** AI-search readiness: what the plugin can verify on the site (0 to 100); null when no audit ran. */
  score: number | null;
  band: GeoBand | null;
  complete: boolean;
  checkedOn: string | null;
  breakdown: Record<string, SectionScore>;
  blockedSearchBots: string[];
  llms: string | null;
  /** How often sampled AI answers named or cited the business (the agent's samples, latest per question and assistant). */
  mentions: { sampled: number; visible: number; rate: number | null; lastSampledOn: string | null } | null;
}

export function geoSnapshot(audit: StoredGeoAudit | null, stats: MentionStats | null): GeoSnapshot {
  return {
    score: audit?.score ?? null,
    band: audit?.band ?? null,
    complete: audit?.complete ?? false,
    checkedOn: audit?.auditedOn ?? null,
    breakdown: (audit?.breakdown ?? {}) as Record<string, SectionScore>,
    blockedSearchBots: blockedSearchBots(audit?.sections ?? null),
    llms: audit?.sections?.llms?.quality ?? null,
    mentions: stats && stats.sampled > 0 ? { sampled: stats.sampled, visible: stats.visible, rate: stats.rate, lastSampledOn: stats.lastSampledOn } : null,
  };
}

/** A line a person reads: "AI-search readiness 72/100 (good); named in 3 of 12 sampled AI answers". */
export function geoLine(snapshot: GeoSnapshot): string {
  const parts: string[] = [];
  parts.push(snapshot.score == null ? "AI-search readiness not checked yet" : `AI-search readiness ${snapshot.score}/100 (${snapshot.band}${snapshot.complete ? "" : ", partly checked"})`);
  if (snapshot.mentions) parts.push(`the business appeared in ${snapshot.mentions.visible} of ${snapshot.mentions.sampled} sampled AI answers`);
  if (snapshot.blockedSearchBots.length > 0) parts.push(`blocked: ${snapshot.blockedSearchBots.slice(0, 4).join(", ")}`);
  return parts.join("; ");
}
