/**
 * GEO (AI search): the `geo-audit` tool, the AI answers an agent sampled (`record-ai-mentions`, `list-ai-mentions`),
 * the readiness score kept on snapshots, the scheduled re-check and the monthly recurring task. The pure checks are
 * in checks/geo.ts, the rules in engine/geo.ts.
 *
 * The plugin has no account with any AI provider and invents nothing: the audit reads the site, and an answer is
 * recorded only as the agent reports it, with the evidence.
 */
import { randomUUID } from "node:crypto";
import { GEO_SECTIONS, runGeoAudit, type GeoAuditInput, type GeoAuditResult } from "../checks/geo.js";
import * as db from "../db.js";
import { geoFirewallItem } from "../engine/items.js";
import {
  AI_ENGINES,
  blockedSearchBots,
  compactGeo,
  ENGINE_LABELS,
  geoChange,
  geoLine,
  geoSnapshot,
  latestSamples,
  mentionStats,
  mentionTrend,
  parseMentionSamples,
  queryKey,
  suggestAiQueries,
  type GeoChange,
  type GeoSnapshot,
  type StoredGeoAudit,
} from "../engine/geo.js";
import { offMessage } from "../engine/switches.js";
import { isRunning, sprintClock } from "../engine/sprint.js";
import { daysBetween } from "../engine/time.js";
import { phaseForWeek } from "../templates/outrank-90.js";
import { monthlyGeoKey } from "../templates/geo.js";
import { businessTypeOf } from "../templates/plans.js";
import { actorId, bool, companyInfo, errorMessage, num, reqStr, SeoError, str, strList, urlParam, type Actor, type CompanyInfo, type Env, type Params } from "./common.js";
import { requireSprint } from "./context.js";
import { addNeedsYou, isPersonLabel, lastNeedsYouItem, PLUGIN_CHECK_BY, resolveNeedsYou } from "./needs-you.js";
import { recordCheckFindings } from "./checks.js";
import { requireOn } from "./switches.js";

/** An audit this recent is reused for a snapshot instead of fetching the site again. */
export const SNAPSHOT_REUSE_DAYS = 7;
/** The scheduled re-check runs when the last audit is older than this. */
export const SCHEDULED_AUDIT_DAYS = 28;

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function storedAudit(row: db.GeoAuditRow): StoredGeoAudit {
  return { id: row.id, auditedOn: row.auditedOn, score: row.score, band: row.band as StoredGeoAudit["band"], complete: row.complete, breakdown: row.breakdown as StoredGeoAudit["breakdown"], sections: row.sections as StoredGeoAudit["sections"] };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** What the audit needs from the sprint: its live listings, its own pages, its names. */
export async function sprintAuditInput(env: Env, sprint: db.Sprint): Promise<GeoAuditInput> {
  const [backlinks, content, keywords] = await Promise.all([
    db.listBacklinks(env.ctx.db, sprint.companyId, sprint.id, { status: "live" }),
    db.listContent(env.ctx.db, sprint.companyId, sprint.id, { status: "live" }),
    db.listKeywords(env.ctx.db, sprint.companyId, sprint.id),
  ]);
  const preferred = [...new Set([...content.map((c) => c.targetUrl), ...keywords.map((k) => k.targetUrl)].filter((u): u is string => Boolean(u)).map((u) => {
    try {
      return new URL(u, sprint.siteUrl).toString();
    } catch {
      return "";
    }
  }).filter(Boolean))];
  return {
    siteUrl: sprint.siteUrl,
    needsAddress: businessTypeOf(sprint.templateId) !== "saas",
    brandNames: [sprint.siteName, sprint.clientName].filter((n): n is string => Boolean(n && n.trim())),
    preferredPages: preferred,
    directories: backlinks.filter((b) => (b.type === "directory" || b.type === "citation") && b.url).map((b) => ({ url: b.url!, source: b.source })).slice(0, 8),
  };
}

export interface AuditOutcome {
  result: GeoAuditResult;
  audit: db.GeoAuditRow | null;
  previous: db.GeoAuditRow | null;
  change: GeoChange | null;
  stored: { recorded: number; resolved: number } | null;
}

/**
 * Audit a sprint's site. Stores the audit row and its findings (a re-run closes what it no longer reports), and keeps
 * the firewall item on Needs you in step with what the probes saw. An audit where nothing could be checked (the site
 * did not answer) is returned but not stored.
 */
export async function auditSprint(env: Env, info: CompanyInfo, sprint: db.Sprint, opts: { source: "tool" | "snapshot" | "scheduled"; pages?: string[]; deadlineMs?: number; store?: boolean }): Promise<AuditOutcome> {
  // The one place that reads the client's site for AI search: never for a sprint a person has not switched it on for.
  requireOn(sprint, "geo", offMessage("geo"));
  const input = await sprintAuditInput(env, sprint);
  const result = await runGeoAudit(env.site, { ...input, ...(opts.pages?.length ? { pages: opts.pages } : {}), ...(opts.deadlineMs ? { deadlineMs: opts.deadlineMs } : {}) });
  const evaluated = GEO_SECTIONS.some((s) => result.breakdown[s].evaluated);
  if (opts.store === false || !evaluated) return { result, audit: null, previous: null, change: null, stored: null };
  const previous = await db.latestGeoAudit(env.ctx.db, sprint.companyId, sprint.id);
  const stored = await recordCheckFindings(env, sprint, "geo-audit", result.findings, result.covered);
  const row: db.GeoAuditRow = {
    id: randomUUID(),
    sprintId: sprint.id,
    auditedOn: info.today,
    auditedAt: env.now().toISOString(),
    score: result.score,
    band: result.band,
    complete: result.complete,
    breakdown: result.breakdown as unknown as Record<string, unknown>,
    sections: compactGeo(result) as unknown as Record<string, unknown>,
    findingCount: result.findings.filter((f) => f.severity !== "info").length,
    source: opts.source,
  };
  await db.insertGeoAudit(env.ctx.db, { ...row, companyId: sprint.companyId, source: opts.source });
  const audit = row;
  const change = geoChange(previous ? storedAudit(previous) : null, storedAudit(audit));
  await syncFirewallItem(env, info, sprint, result).catch((error: unknown) => env.ctx.logger.info("SEO geo firewall item not updated", { sprintId: sprint.id, error: errorMessage(error) }));
  return { result, audit, previous, change, stored };
}

/**
 * A search bot the server refused twice is something only the site's owner can look at; once the probes pass the item
 * closes. An owner who marked it done as a false alarm (a CDN that lets the real bots in by their own addresses) is not
 * asked again for the same bots. Training crawlers never raise it: refusing them is the client's choice.
 */
async function syncFirewallItem(env: Env, info: CompanyInfo, sprint: db.Sprint, result: GeoAuditResult): Promise<void> {
  if (result.serverProbes.length === 0) return;
  const refused = result.serverProbes.filter((p) => p.blocked && p.kind === "search");
  if (refused.length > 0) {
    const last = await lastNeedsYouItem(env, sprint, "geo_firewall");
    const dismissed = last?.status === "done" && isPersonLabel(last.doneBy) && refused.every((p) => last.why.includes(p.token));
    if (dismissed) return;
    const open = await db.listTasks(env.ctx.db, sprint.companyId, sprint.id, { status: ["not_started", "in_progress", "blocked"] });
    const taskIds = open.filter((t) => t.taskType === "geo-crawler-access").map((t) => t.id);
    await addNeedsYou(env, info, sprint, geoFirewallItem(sprint, refused.map((p) => ({ token: p.token, detail: p.detail })), taskIds), { reopen: true });
  } else {
    await resolveNeedsYou(env, info, sprint, "geo_firewall", PLUGIN_CHECK_BY, "A new audit sees no server refusal.");
  }
}

// ---------------------------------------------------------------------------
// geo-audit
// ---------------------------------------------------------------------------

function nextSteps(result: GeoAuditResult, mentionSamples: number | null): string[] {
  const next: string[] = [];
  const robots = result.crawlers.filter((c) => c.kind !== "training" && c.state !== "allowed" && c.via === "own-rule").map((c) => c.token);
  if (result.crawlers.some((c) => c.via === "wildcard" && c.kind === "search" && c.state === "blocked")) next.push("robots.txt blocks every crawler: fix it first (task w0-geo-crawlers).");
  else if (robots.length > 0) next.push(`robots.txt blocks ${robots.join(", ")}: remove or narrow those rules (task w0-geo-crawlers). Training crawlers are the client's choice.`);
  const refused = result.serverProbes.filter((p) => p.blocked && p.kind === "search").map((p) => p.token);
  if (refused.length > 0) next.push(`The server refuses ${refused.join(", ")}: the firewall item is on Needs you (geo_firewall); you cannot change it.`);
  if (result.llms?.quality === "missing" || result.llms?.quality === "invalid") next.push("No usable llms.txt: optional and unproven, cheap to add (task w1-geo-llms-txt).");
  if (result.entity && result.entity.score < 80) next.push(`Organisation data scores ${result.entity.score}/100: ${result.entity.checks.filter((c) => c.earned < 1).map((c) => c.label.toLowerCase()).slice(0, 4).join(", ")} (task w1-geo-entity).`);
  if (!result.entity?.found && result.entity !== null) next.push("No organisation data on the home page (task w1-geo-entity).");
  const unready = result.answers.filter((a) => !a.answerReady).length;
  if (unready > 0) next.push(`${unready} of ${result.answers.length} sampled pages have no short direct answer under a question heading (task w4-geo-answers).`);
  if (result.sameAs.some((c) => c.state === "broken" || c.state === "no-match") || result.directories.some((d) => d.nameFound === false || d.phoneFound === false)) next.push("A profile or listing is broken or shows another name or phone (task w6-geo-brand).");
  if (mentionSamples === 0) next.push("No AI answers sampled yet: ask the key questions and record them with record-ai-mentions (task w2-geo-baseline).");
  if (next.length === 0) next.push("Nothing blocks AI search from reading this site. Keep sampling AI answers (record-ai-mentions) to see whether the business is named.");
  return next;
}

export function geoAuditView(outcome: AuditOutcome, extra: { sprintId?: string; mentionSamples?: number | null; dryRun?: boolean } = {}) {
  const { result } = outcome;
  const bots = (kind: string) => result.crawlers.filter((c) => c.kind === kind).map((c) => ({ token: c.token, state: c.state, via: c.via, ...(c.blockedPaths.length > 0 ? { blockedPaths: c.blockedPaths.slice(0, 3) } : {}) }));
  const sorted = [...result.findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  return {
    ...(extra.sprintId ? { sprintId: extra.sprintId } : {}),
    siteUrl: result.siteUrl,
    score: result.score,
    band: result.band,
    complete: result.complete,
    meaning: "AI-search readiness: what can be verified on the site (crawler access, organisation data, answer blocks, brand consistency, llms.txt, snippet limits). It does not say how often AI assistants mention the business: that is record-ai-mentions / list-ai-mentions.",
    breakdown: result.breakdown,
    crawlers: { search: bots("search"), user: bots("user"), training: bots("training"), note: "Training crawlers are the client's policy choice, never a defect, and do not count in the score." },
    serverProbes: result.serverProbes.map((p) => ({ token: p.token, status: p.status, blocked: p.blocked, ...(p.detail ? { detail: p.detail } : {}) })),
    llms: result.llms ? { quality: result.llms.quality, links: result.llms.links.length, problems: result.llms.problems, note: "llms.txt is an unproven convention; weight 5%." } : null,
    entity: result.entity ? { found: result.entity.found, score: result.entity.score, types: result.entity.types, sameAs: result.entity.sameAs, missing: result.entity.checks.filter((c) => c.earned < 1).map((c) => ({ check: c.key, ...(c.detail ? { detail: c.detail } : {}) })) } : null,
    answers: result.answers.map((a) => ({ url: a.url, questionHeadings: a.questionHeadings, directAnswers: a.directAnswers, faqSchemaQuestions: a.faqSchemaQuestions, faqMatchesPage: a.faqMatchesPage, answerReady: a.answerReady })),
    sameAs: result.sameAs.map((c) => ({ url: c.url, kind: c.kind, state: c.state })),
    directories: result.directories.map((d) => ({ source: d.source, status: d.status, nameFound: d.nameFound, phoneFound: d.phoneFound })),
    snippets: result.snippets,
    findings: sorted.filter((f) => f.severity !== "info").slice(0, 25).map((f) => ({ severity: f.severity, url: f.url, finding: f.finding })),
    findingsTotal: result.findings.filter((f) => f.severity !== "info").length,
    change: outcome.change && outcome.previous ? { previousScore: outcome.previous.score, previousOn: outcome.previous.auditedOn, scoreDelta: outcome.change.scoreDelta, newlyBlocked: outcome.change.newlyBlocked, reopened: outcome.change.reopened } : null,
    stored: outcome.stored ? { ...outcome.stored, auditId: outcome.audit?.id ?? null } : extra.dryRun ? { dryRun: true } : null,
    notes: result.notes,
    next: nextSteps(result, extra.mentionSamples ?? null),
  };
}

export async function geoAuditTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprintId = str(params, "sprintId");
  const url = str(params, "url", { max: 2000 });
  if (!sprintId && !url) throw new SeoError("Pass sprintId (audits the sprint's site and records the result) or url (audits any site, nothing recorded).");
  const info = await companyInfo(env, companyId);
  const dryRun = bool(params, "dryRun") ?? false;
  if (!sprintId) {
    const siteUrl = urlParam(url!);
    const brand = str(params, "brand", { max: 200 });
    // The bot probes are for a sprint's own site: an audit of any other site only reads it.
    const result = await runGeoAudit(env.site, { siteUrl, needsAddress: true, brandNames: brand ? [brand] : [hostOf(siteUrl).split(".")[0] ?? ""], probe: false });
    return geoAuditView({ result, audit: null, previous: null, change: null, stored: null }, { dryRun: true });
  }
  const sprint = await requireSprint(env, companyId, sprintId);
  requireOn(sprint, "geo", offMessage("geo"));
  const site = url ? urlParam(url, sprint.siteUrl) : sprint.siteUrl;
  if (hostOf(site) !== hostOf(sprint.siteUrl)) throw new SeoError("url must be on the sprint's own site. Audit another site without sprintId.");
  const pages = strList(params, "pages", { max: 8, itemMax: 500 }).map((p) => urlParam(p, sprint.siteUrl));
  const outcome = await auditSprint(env, info, sprint, { source: "tool", pages, store: !dryRun });
  const samples = latestSamples(await db.listMentions(env.ctx.db, companyId, sprint.id)).length;
  return geoAuditView(outcome, { sprintId: sprint.id, mentionSamples: samples, dryRun });
}

// ---------------------------------------------------------------------------
// Sampled AI answers
// ---------------------------------------------------------------------------

function mentionView(rows: db.AiMentionRow[]) {
  return rows.map((m) => ({ query: m.query, engine: m.engine, sampledOn: m.sampledOn, mentioned: m.mentioned, cited: m.cited, position: m.position, citedUrls: m.citedUrls.slice(0, 3), competitors: m.competitors, evidence: m.evidence }));
}

export async function recordAiMentionsTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  requireOn(sprint, "geo", offMessage("geo"));
  const info = await companyInfo(env, companyId);
  const parsed = parseMentionSamples(params.samples, { today: info.today, siteHost: hostOf(sprint.siteUrl) });
  if (parsed.samples.length === 0) throw new SeoError(`Nothing was recorded. ${parsed.errors.join(" ")}`);
  for (const sample of parsed.samples) {
    await db.upsertMention(env.ctx.db, {
      id: randomUUID(),
      companyId,
      sprintId: sprint.id,
      query: sample.query,
      queryKey: queryKey(sample.query),
      engine: sample.engine,
      sampledOn: sample.sampledOn,
      mentioned: sample.mentioned,
      cited: sample.cited,
      position: sample.position,
      citedUrls: sample.citedUrls,
      competitors: sample.competitors,
      evidence: sample.evidence,
      note: sample.note,
      method: sample.method,
      recordedBy: actorId(actor),
    });
  }
  const rows = await db.listMentions(env.ctx.db, companyId, sprint.id);
  const stats = mentionStats(rows);
  return {
    sprintId: sprint.id,
    recorded: parsed.samples.length,
    ...(parsed.errors.length > 0 ? { rejected: parsed.errors } : {}),
    stats: { sampled: stats.sampled, questions: stats.questions, mentioned: stats.mentioned, cited: stats.cited, visible: stats.visible, rate: stats.rate },
    trend: mentionTrend(rows),
    next: parsed.errors.length > 0 ? "Fix the rejected samples and send them again. Everything else is recorded." : "Recorded. list-ai-mentions shows the rate, the trend and the competitors named instead.",
  };
}

export async function listAiMentionsTool(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  if (!sprint.geoEnabled) return { sprintId: sprint.id, siteName: sprint.siteName, enabled: false, next: offMessage("geo") };
  const rows = await db.listMentions(env.ctx.db, companyId, sprint.id);
  const stats = mentionStats(rows);
  const latest = latestSamples(rows);
  const byQuestion = new Map<string, db.AiMentionRow[]>();
  for (const row of latest) (byQuestion.get(queryKey(row.query)) ?? byQuestion.set(queryKey(row.query), []).get(queryKey(row.query))!).push(row);
  const limit = num(params, "limit", { integer: true, min: 1, max: 100 }) ?? 30;
  const questions = [...byQuestion.values()].slice(0, limit).map((list) => ({ query: list[0]!.query, answers: mentionView(list).map(({ query: _query, ...rest }) => rest) }));
  const keywords = await db.listKeywords(env.ctx.db, companyId, sprint.id);
  return {
    sprintId: sprint.id,
    siteName: sprint.siteName,
    stats,
    trend: mentionTrend(rows),
    questions,
    ...(stats.questions < 10 ? { suggestedQuestions: suggestAiQueries({ siteName: sprint.siteName, keywords: keywords.map((k) => ({ phrase: k.phrase, isPriority: k.isPriority, intent: k.intent })) }), suggestionNote: "Starting points: add the real questions customers ask (the site's FAQ, gsc-query queries). Ask each with the answer tools you actually have." } : {}),
    engines: AI_ENGINES.map((e) => ({ engine: e, label: ENGINE_LABELS[e] })),
    note: "The rate counts the latest answer per question and assistant. It is a signal from a handful of samples, not a measurement.",
  };
}

// ---------------------------------------------------------------------------
// Snapshots, the page and the digest
// ---------------------------------------------------------------------------

/** The readiness score and the sampling summary for a sprint, from what is stored (no fetching). */
export async function geoSummary(env: Env, sprint: Pick<db.Sprint, "id" | "companyId">): Promise<GeoSnapshot> {
  const [audit, mentions] = await Promise.all([db.latestGeoAudit(env.ctx.db, sprint.companyId, sprint.id), db.listMentions(env.ctx.db, sprint.companyId, sprint.id)]);
  return geoSnapshot(audit ? storedAudit(audit) : null, mentionStats(mentions));
}

/**
 * The `geo` part of a snapshot: the latest audit when it is under a week old, else a fresh one (kept, so the next
 * snapshot reuses it). A site that does not answer leaves the last audit in place; never throws.
 */
export async function geoForSnapshot(env: Env, info: CompanyInfo, sprint: db.Sprint): Promise<GeoSnapshot> {
  try {
    const latest = await db.latestGeoAudit(env.ctx.db, sprint.companyId, sprint.id);
    const age = latest ? daysBetween(latest.auditedOn, info.today) : null;
    if (age == null || age > SNAPSHOT_REUSE_DAYS) await auditSprint(env, info, sprint, { source: "snapshot", deadlineMs: 15_000 });
  } catch (error) {
    env.ctx.logger.info("SEO geo audit for the snapshot failed", { sprintId: sprint.id, error: errorMessage(error) });
  }
  return geoSummary(env, sprint);
}

export { geoLine };

// ---------------------------------------------------------------------------
// Scheduled work (the daily run)
// ---------------------------------------------------------------------------

/** An open geo_firewall item is re-checked each day; otherwise an audit older than SCHEDULED_AUDIT_DAYS (or none yet) is refreshed. */
export async function scheduledGeo(env: Env, info: CompanyInfo, sprint: db.Sprint, day: number): Promise<{ audited: boolean; change: GeoChange | null }> {
  if (day < 0 || !isRunning(sprint.status) || !sprint.geoEnabled) return { audited: false, change: null };
  const latest = await db.latestGeoAudit(env.ctx.db, sprint.companyId, sprint.id);
  const age = latest ? daysBetween(latest.auditedOn, info.today) : null;
  const firewallOpen = (await db.openNeedsYouDigests(env.ctx.db, sprint.companyId)).some((d) => d.sprintId === sprint.id && d.items.some((i) => i.key === "geo_firewall" && i.status === "open"));
  const due = age == null || age >= SCHEDULED_AUDIT_DAYS || (firewallOpen && age >= 1);
  if (!due) return { audited: false, change: null };
  const outcome = await auditSprint(env, info, sprint, { source: "scheduled", deadlineMs: 15_000 });
  return { audited: Boolean(outcome.audit), change: outcome.change };
}

/**
 * After day 90 (compounding) the plan has no GEO tasks left: open a monthly re-check, once per calendar month, due at
 * once. The playbook is the week-8 re-check's. Returns the new task's id or null.
 */
export async function ensureMonthlyGeoTask(env: Env, info: CompanyInfo, sprint: db.Sprint): Promise<string | null> {
  const clock = sprintClock(sprint.startDate, info.today);
  if (!sprint.geoEnabled || clock.runningStatus !== "compounding" || !isRunning(sprint.status) || !sprint.seededAt) return null;
  const month = info.today.slice(0, 7);
  const id = randomUUID();
  const inserted = await db.insertTasks(env.ctx.db, [{
    id,
    companyId: sprint.companyId,
    sprintId: sprint.id,
    templateKey: monthlyGeoKey(month),
    week: clock.week,
    phase: phaseForWeek(clock.week),
    dueDay: clock.day,
    focus: "AI search",
    title: `Monthly AI search check (${month}): ask the same questions again and compare`,
    description: null,
    taskType: "geo-mention-check",
    owner: "agent",
    autopilotEligible: true,
    playbookKey: "w8-geo-recheck",
    source: "template",
    parentOptimizationId: null,
    context: "Recurring after day 90: AI answers change month to month, so the baseline questions are asked again.",
  }]);
  return inserted > 0 ? id : null;
}
