/**
 * Keywords, positions, backlinks, content, legacy pages and findings.
 */
import { randomUUID } from "node:crypto";
import * as db from "../db.js";
import { contentWentLive } from "./handoff.js";
import { keywordStatusForPosition } from "../engine/sprint.js";
import { discoverKeywords, inferIntent, type Intent } from "../integrations/autocomplete.js";
import {
  actorId,
  bool,
  companyInfo,
  isoDateParam,
  num,
  oneOf,
  reqStr,
  SeoError,
  str,
  strList,
  urlParam,
  type Actor,
  type Env,
  type Params,
} from "./common.js";
import { assertWritable, requireSprint } from "./context.js";
import { classifyIntents } from "./intent.js";

/** Names a searcher would use for the sprint's own brand (site, client, domain label). */
function sprintBrandTerms(sprint: db.Sprint): string[] {
  let host = "";
  try {
    host = new URL(sprint.siteUrl).hostname.replace(/^www\./, "").split(".")[0] ?? "";
  } catch {
    host = "";
  }
  return [sprint.siteName, sprint.clientName ?? sprint.legacyClientName ?? "", host].filter(Boolean);
}

export const INTENTS = ["problem", "solution", "brand"] as const;
export const BACKLINK_TYPES = ["directory", "community", "guest_post", "link_trade", "organic", "citation", "other"] as const;
export const BACKLINK_STATUSES = ["not_started", "in_progress", "submitted", "live", "rejected", "lost"] as const;
export const CONTENT_TYPES = ["post", "page", "comparison", "alternative", "use-case", "pillar", "cluster", "how-to", "feature"] as const;
export const CONTENT_STATUSES = ["idea", "drafting", "review", "scheduled", "live", "archived"] as const;
export const FINDING_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

function keywordView(k: db.Keyword) {
  return {
    keywordId: k.id,
    phrase: k.phrase,
    intent: k.intent,
    priority: k.isPriority,
    volume: k.volume,
    difficultyDr: k.difficultyDr,
    targetUrl: k.targetUrl,
    rankingUrl: k.rankingUrl,
    position: k.currentPosition,
    impressions: k.impressions,
    clicks: k.clicks,
    ctr: k.ctr,
    status: k.status,
    retired: Boolean(k.retiredAt),
    notes: k.notes,
    lastPulledAt: k.lastPulledAt,
  };
}

async function requireKeyword(env: Env, companyId: string, params: Params): Promise<db.Keyword> {
  const id = reqStr(params, "keywordId");
  const keyword = await db.getKeyword(env.ctx.db, companyId, id);
  if (!keyword) throw new SeoError(`Keyword ${id} was not found`);
  return keyword;
}

export async function listKeywordsTool(env: Env, companyId: string, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const keywords = await db.listKeywords(env.ctx.db, companyId, sprintId, { includeRetired: bool(params, "includeRetired") ?? false });
  return { sprintId, count: keywords.length, keywords: keywords.map(keywordView) };
}

interface KeywordInput {
  phrase: string;
  volume: number | null;
  intent: string | null;
  targetUrl: string | null;
  difficultyDr: number | null;
  isPriority: boolean;
  notes: string | null;
}

function parseKeywordInput(raw: Params, siteUrl: string): KeywordInput {
  const phrase = reqStr(raw, "phrase", { max: 200 }).replace(/\s+/g, " ");
  const target = str(raw, "targetUrl", { max: 1000 });
  return {
    phrase,
    volume: num(raw, "volume", { integer: true, min: 0 }) ?? null,
    intent: oneOf(raw, "intent", INTENTS) ?? null,
    targetUrl: target ? urlParam(target, siteUrl) : null,
    difficultyDr: num(raw, "difficultyDr", { integer: true, min: 0, max: 100 }) ?? null,
    isPriority: bool(raw, "priority") ?? false,
    notes: str(raw, "notes", { max: 2000 }) ?? null,
  };
}

export async function addKeywords(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const raw = Array.isArray(params.keywords) ? params.keywords : params.phrase ? [params] : null;
  if (!raw || raw.length === 0) throw new SeoError("keywords must be a non-empty list of {phrase, …}");
  if (raw.length > 200) throw new SeoError("Add at most 200 keywords per call");
  const added: Array<{ keywordId: string; phrase: string; intent: string | null; intentSource?: "jev" | "rules" }> = [];
  const skipped: Array<{ phrase: string; reason: string }> = [];
  const inputs: KeywordInput[] = [];
  for (const item of raw) {
    const entry = typeof item === "string" ? { phrase: item } : (item as Params);
    try {
      inputs.push(parseKeywordInput(entry, sprint.siteUrl));
    } catch (error) {
      skipped.push({ phrase: String((entry as Params).phrase ?? ""), reason: error instanceof Error ? error.message : "invalid" });
    }
  }
  // Keywords without an intent get one: Jev when it is sure enough, else the regex guess.
  const missing = inputs.filter((input) => !input.intent);
  const brandTerms = sprintBrandTerms(sprint);
  const guessed = await classifyIntents(
    env,
    companyId,
    missing.map((input) => ({ phrase: input.phrase, fallback: inferIntent(input.phrase, brandTerms) })),
    { siteName: sprint.siteName, sprintId: sprint.id },
  );
  const sourceByInput = new Map<KeywordInput, "jev" | "rules">();
  missing.forEach((input, index) => {
    input.intent = guessed[index]!.intent;
    sourceByInput.set(input, guessed[index]!.source);
  });
  for (const input of inputs) {
    const id = randomUUID();
    const inserted = await db.insertKeyword(env.ctx.db, {
      id,
      companyId,
      sprintId: sprint.id,
      ...input,
      source: actor.kind === "agent" ? "agent" : "manual",
    });
    if (inserted) {
      const source = sourceByInput.get(input);
      added.push({ keywordId: id, phrase: input.phrase, intent: input.intent, ...(source ? { intentSource: source } : {}) });
    } else skipped.push({ phrase: input.phrase, reason: "already tracked" });
  }
  return { sprintId: sprint.id, added: added.length, skipped: skipped.length, keywords: added, skippedDetail: skipped };
}

export async function updateKeywordTool(env: Env, companyId: string, params: Params) {
  const keyword = await requireKeyword(env, companyId, params);
  const sprint = await requireSprint(env, companyId, keyword.sprintId);
  const patch: Record<string, unknown> = {};
  const phrase = str(params, "phrase", { max: 200 });
  if (phrase && phrase.toLowerCase() !== keyword.phrase.toLowerCase()) {
    const clash = await db.findKeyword(env.ctx.db, companyId, keyword.sprintId, phrase);
    if (clash) throw new SeoError(`"${phrase}" is already tracked on this sprint`);
    patch.phrase = phrase.replace(/\s+/g, " ");
  }
  const volume = num(params, "volume", { integer: true, min: 0 });
  if (volume !== undefined) patch.volume = volume;
  const intent = oneOf(params, "intent", INTENTS);
  if (intent) patch.intent = intent;
  const target = str(params, "targetUrl", { max: 1000 });
  if (target !== undefined) patch.target_url = urlParam(target, sprint.siteUrl);
  else if (params.targetUrl === "" || params.targetUrl === null) patch.target_url = null;
  const dr = num(params, "difficultyDr", { integer: true, min: 0, max: 100 });
  if (dr !== undefined) patch.difficulty_dr = dr;
  const priority = bool(params, "priority");
  if (priority !== undefined) patch.is_priority = priority;
  if (params.notes !== undefined) patch.notes = str(params, "notes", { max: 2000 }) ?? null;
  if (Object.keys(patch).length === 0) throw new SeoError("Nothing to update");
  await db.updateKeyword(env.ctx.db, companyId, keyword.id, patch);
  return { keywordId: keyword.id, updated: Object.keys(patch) };
}

export async function retireKeyword(env: Env, companyId: string, params: Params) {
  const keyword = await requireKeyword(env, companyId, params);
  if (keyword.retiredAt) return { keywordId: keyword.id, alreadyRetired: true };
  await db.updateKeyword(env.ctx.db, companyId, keyword.id, {
    retired_at: new Date().toISOString(),
    retired_reason: str(params, "reason", { max: 500 }) ?? "retired",
  });
  return { keywordId: keyword.id, retired: true };
}

/** Manual position (and the legacy record-rank alias). */
export async function recordPosition(env: Env, companyId: string, actor: Actor, params: Params) {
  let keyword: db.Keyword | null = null;
  if (params.keywordId) keyword = await requireKeyword(env, companyId, params);
  else {
    const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
    const phrase = reqStr(params, "phrase", { max: 200 });
    keyword = await db.findKeyword(env.ctx.db, companyId, sprint.id, phrase);
    if (!keyword) {
      const id = randomUUID();
      await db.insertKeyword(env.ctx.db, {
        id, companyId, sprintId: sprint.id, phrase, volume: null, intent: null, targetUrl: null, difficultyDr: null, isPriority: false, notes: null, source: "manual",
      });
      keyword = await db.getKeyword(env.ctx.db, companyId, id);
    }
  }
  if (!keyword) throw new SeoError("Keyword could not be resolved");
  const position = num(params, "position", { min: 0.5, max: 500 }) ?? num(params, "rank", { min: 1, max: 500, integer: true });
  if (position == null) throw new SeoError("position is required (the rank you observed, e.g. 12)");
  const info = await companyInfo(env, companyId);
  const recordedOn = isoDateParam(params, "recordedOn") ?? info.today;
  const impressions = num(params, "impressions", { integer: true, min: 0 }) ?? null;
  const clicks = num(params, "clicks", { integer: true, min: 0 }) ?? null;
  await db.recordPosition(env.ctx.db, {
    id: randomUUID(),
    companyId,
    sprintId: keyword.sprintId,
    keywordId: keyword.id,
    position,
    impressions,
    clicks,
    ctr: impressions && clicks != null ? clicks / impressions : null,
    source: "manual",
    recordedOn,
  });
  await db.updateKeyword(env.ctx.db, companyId, keyword.id, {
    current_position: position,
    rank: Math.round(position),
    status: keywordStatusForPosition(position),
    ...(impressions != null ? { impressions } : {}),
    ...(clicks != null ? { clicks } : {}),
  });
  return { keywordId: keyword.id, sprintId: keyword.sprintId, phrase: keyword.phrase, position, recordedOn, source: "manual", by: actorId(actor) };
}

export async function keywordHistoryTool(env: Env, companyId: string, params: Params) {
  const keyword = await requireKeyword(env, companyId, params);
  const history = await db.keywordHistory(env.ctx.db, companyId, keyword.id, num(params, "limit", { integer: true, min: 1, max: 365 }) ?? 90);
  return { keywordId: keyword.id, phrase: keyword.phrase, current: keyword.currentPosition, history };
}

export async function discoverKeywordsTool(env: Env, companyId: string, params: Params) {
  const seeds = strList(params, "seeds", { max: 8, itemMax: 100 });
  if (seeds.length === 0) throw new SeoError("seeds is required (1–8 seed terms)");
  let brandTerms: string[] = [];
  let exclude: string[] = [];
  let siteName: string | null = null;
  const sprintId = str(params, "sprintId");
  if (sprintId) {
    const sprint = await requireSprint(env, companyId, sprintId);
    brandTerms = sprintBrandTerms(sprint);
    siteName = sprint.siteName;
    exclude = (await db.listKeywords(env.ctx.db, companyId, sprint.id)).map((k) => k.phrase);
  }
  const candidates = await discoverKeywords(env.fetch, {
    seeds,
    limit: num(params, "limit", { integer: true, min: 1, max: 200 }) ?? 60,
    language: str(params, "language", { max: 10 }) ?? "en",
    country: str(params, "country", { max: 5 }) ?? "za",
    brandTerms,
    exclude,
  });
  const intents = await classifyIntents(
    env,
    companyId,
    candidates.map((candidate) => ({ phrase: candidate.phrase, fallback: candidate.intent })),
    { siteName, sprintId: sprintId ?? null },
  );
  const classified = candidates.map((candidate, index) => ({
    ...candidate,
    intent: intents[index]!.intent as Intent,
    intentSource: intents[index]!.source,
  }));
  return {
    seeds,
    count: classified.length,
    candidates: classified,
    note: "Suggestions come from Google Autocomplete (real searches, no volumes) plus seed variants (unverified patterns). Intent comes from Jev when it is sure (intentSource jev), else from word rules. Check the live results before choosing; save picks with add-keywords.",
  };
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

function backlinkView(b: db.Backlink) {
  return {
    backlinkId: b.id,
    source: b.source,
    domain: b.domain,
    type: b.type,
    dr: b.dr,
    status: b.status,
    url: b.url,
    submitUrl: b.submitUrl,
    submittedAt: b.submittedAt,
    liveAt: b.liveAt,
    notes: b.notes,
    discoveredVia: b.discoveredVia,
  };
}

function domainOf(value: string): string {
  const raw = value.trim().toLowerCase();
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
  } catch {
    throw new SeoError(`Not a valid domain: ${value}`);
  }
}

export async function listBacklinksTool(env: Env, companyId: string, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const list = await db.listBacklinks(env.ctx.db, companyId, sprintId, {
    status: oneOf(params, "status", BACKLINK_STATUSES),
    type: oneOf(params, "type", BACKLINK_TYPES),
  });
  const byStatus: Record<string, number> = {};
  for (const b of list) byStatus[b.status] = (byStatus[b.status] ?? 0) + 1;
  return { sprintId, count: list.length, byStatus, backlinks: list.map(backlinkView) };
}

export async function addBacklink(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const domain = domainOf(reqStr(params, "domain", { max: 300 }));
  const url = str(params, "url", { max: 1000 });
  const submitUrl = str(params, "submitUrl", { max: 1000 });
  const id = randomUUID();
  await db.insertBacklinks(env.ctx.db, [{
    id,
    companyId,
    sprintId: sprint.id,
    source: str(params, "source", { max: 200 }) ?? domain,
    domain,
    url: url ? urlParam(url) : null,
    submitUrl: submitUrl ? urlParam(submitUrl) : null,
    type: oneOf(params, "type", BACKLINK_TYPES) ?? "other",
    dr: num(params, "dr", { integer: true, min: 0, max: 100 }) ?? null,
    status: oneOf(params, "status", BACKLINK_STATUSES) ?? "not_started",
    notes: str(params, "notes", { max: 4000 }) ?? null,
    discoveredVia: actor.kind === "agent" ? "agent" : "manual",
  }]);
  return { backlinkId: id, sprintId: sprint.id, domain };
}

export async function updateBacklinkTool(env: Env, companyId: string, actor: Actor, params: Params) {
  const id = reqStr(params, "backlinkId");
  const link = await db.getBacklink(env.ctx.db, companyId, id);
  if (!link) throw new SeoError(`Backlink ${id} was not found`);
  const patch: Record<string, unknown> = {};
  const status = oneOf(params, "status", BACKLINK_STATUSES);
  const notes = str(params, "notes", { max: 4000 });
  if (status && status !== link.status) {
    patch.status = status;
    const now = new Date().toISOString();
    if (status === "submitted" && !link.submittedAt) patch.submitted_at = now;
    if (status === "live") {
      patch.live_at = now;
      if (!link.submittedAt) patch.submitted_at = now;
    }
    if ((status === "submitted" || status === "rejected" || status === "lost") && !notes && !link.notes) {
      throw new SeoError(`Add notes when marking a backlink ${status} (where it was submitted, or why it was rejected/lost)`);
    }
  }
  const url = str(params, "url", { max: 1000 });
  if (url) patch.url = urlParam(url);
  if (status === "live" && !url && !link.url) throw new SeoError("Give the url of the live listing when marking a backlink live");
  const submitUrl = str(params, "submitUrl", { max: 1000 });
  if (submitUrl) patch.submit_url = urlParam(submitUrl);
  const dr = num(params, "dr", { integer: true, min: 0, max: 100 });
  if (dr !== undefined) patch.dr = dr;
  const type = oneOf(params, "type", BACKLINK_TYPES);
  if (type) patch.type = type;
  if (notes) patch.notes = link.notes && !link.notes.includes(notes) ? `${link.notes}\n${notes}` : notes;
  if (Object.keys(patch).length === 0) throw new SeoError("Nothing to update");
  patch.evidence = { ...(link.evidence ?? {}), lastChange: { by: actorId(actor), at: new Date().toISOString(), status: status ?? link.status } };
  await db.updateBacklink(env.ctx.db, companyId, link.id, patch);
  return { backlinkId: link.id, updated: Object.keys(patch).filter((k) => k !== "evidence") };
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function contentView(c: db.ContentItem) {
  return {
    contentId: c.id,
    title: c.title,
    type: c.type,
    status: c.status,
    targetKeywordId: c.targetKeywordId,
    targetUrl: c.targetUrl,
    publishOn: c.publishOn,
    publishedOn: c.publishedOn,
    socialPosts: c.socialPostIds,
    internalLinksAdded: c.internalLinksAdded,
    linksToPillarIds: c.linksToPillarIds,
    impressions: c.impressions,
    clicks: c.clicks,
    position: c.position,
    notes: c.notes,
  };
}

export async function listContentTool(env: Env, companyId: string, params: Params) {
  const sprintId = reqStr(params, "sprintId");
  const list = await db.listContent(env.ctx.db, companyId, sprintId, {
    status: oneOf(params, "status", CONTENT_STATUSES),
    type: oneOf(params, "type", CONTENT_TYPES),
  });
  return { sprintId, count: list.length, content: list.map(contentView) };
}

async function checkKeywordRef(env: Env, companyId: string, sprintId: string, keywordId: string | undefined): Promise<string | null> {
  if (!keywordId) return null;
  const keyword = await db.getKeyword(env.ctx.db, companyId, keywordId);
  if (!keyword || keyword.sprintId !== sprintId) throw new SeoError(`Keyword ${keywordId} is not on this sprint`);
  return keyword.id;
}

export async function addContent(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  assertWritable(sprint);
  const status = oneOf(params, "status", CONTENT_STATUSES) ?? "idea";
  const target = str(params, "targetUrl", { max: 1000 });
  const info = await companyInfo(env, companyId);
  const id = randomUUID();
  await db.insertContent(env.ctx.db, {
    id,
    companyId,
    sprintId: sprint.id,
    title: reqStr(params, "title", { max: 300 }),
    type: oneOf(params, "type", CONTENT_TYPES) ?? "post",
    status,
    targetKeywordId: await checkKeywordRef(env, companyId, sprint.id, str(params, "targetKeywordId")),
    targetUrl: target ? urlParam(target, sprint.siteUrl) : null,
    publishOn: isoDateParam(params, "publishOn") ?? null,
    publishedOn: status === "live" ? isoDateParam(params, "publishedOn") ?? info.today : null,
    taskId: str(params, "taskId") ?? null,
    notes: str(params, "notes", { max: 4000 }) ?? null,
  });
  // Live now: Social repurposes it (content.published).
  if (status === "live") await contentWentLive(env, companyId, id);
  return { contentId: id, sprintId: sprint.id, status };
}

export async function updateContentTool(env: Env, companyId: string, params: Params) {
  const id = reqStr(params, "contentId");
  const content = await db.getContent(env.ctx.db, companyId, id);
  if (!content) throw new SeoError(`Content ${id} was not found`);
  const sprint = await requireSprint(env, companyId, content.sprintId);
  const patch: Record<string, unknown> = {};
  const title = str(params, "title", { max: 300 });
  if (title) patch.title = title;
  const type = oneOf(params, "type", CONTENT_TYPES);
  if (type) patch.type = type;
  const status = oneOf(params, "status", CONTENT_STATUSES);
  const target = str(params, "targetUrl", { max: 1000 });
  if (target) patch.target_url = urlParam(target, sprint.siteUrl);
  if (status) {
    patch.status = status;
    if (status === "live") {
      if (!target && !content.targetUrl) throw new SeoError("Give targetUrl (the live URL) when marking content live");
      const info = await companyInfo(env, companyId);
      patch.published_on = isoDateParam(params, "publishedOn") ?? content.publishedOn ?? info.today;
    }
  }
  const publishOn = isoDateParam(params, "publishOn");
  if (publishOn) patch.publish_on = publishOn;
  const keywordId = str(params, "targetKeywordId");
  if (keywordId) patch.target_keyword_id = await checkKeywordRef(env, companyId, sprint.id, keywordId);
  const links = bool(params, "internalLinksAdded");
  if (links !== undefined) patch.internal_links_added = links;
  if (params.linksToPillarIds !== undefined) {
    const ids = strList(params, "linksToPillarIds", { max: 20, itemMax: 80 });
    for (const pillarId of ids) {
      const pillar = await db.getContent(env.ctx.db, companyId, pillarId);
      if (!pillar || pillar.sprintId !== sprint.id) throw new SeoError(`Pillar ${pillarId} is not content on this sprint`);
      if (pillarId === content.id) throw new SeoError("Content cannot link to itself as its pillar");
    }
    patch.links_to_pillar_ids = [...new Set(ids)];
    if (ids.length > 0) patch.internal_links_added = true;
  }
  if (params.notes !== undefined) patch.notes = str(params, "notes", { max: 4000 }) ?? null;
  if (Object.keys(patch).length === 0) throw new SeoError("Nothing to update");
  await db.updateContent(env.ctx.db, companyId, content.id, patch);
  if (status === "live" && content.status !== "live") await contentWentLive(env, companyId, content.id);
  return { contentId: content.id, updated: Object.keys(patch) };
}

export async function linkSocialPost(env: Env, companyId: string, params: Params) {
  const id = reqStr(params, "contentId");
  const content = await db.getContent(env.ctx.db, companyId, id);
  if (!content) throw new SeoError(`Content ${id} was not found`);
  const postId = reqStr(params, "socialPostId", { max: 200 });
  const entry = [postId, str(params, "platform", { max: 40 }), str(params, "url", { max: 1000 })].filter(Boolean).join("|");
  const existing = content.socialPostIds.filter((e) => e.split("|")[0] !== postId);
  await db.updateContent(env.ctx.db, companyId, content.id, { social_post_ids: [...existing, entry] });
  return { contentId: content.id, socialPosts: [...existing, entry] };
}

export async function addPage(env: Env, companyId: string, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const id = randomUUID();
  await db.insertPage(env.ctx.db, {
    id,
    companyId,
    sprintId: sprint.id,
    url: urlParam(reqStr(params, "url", { max: 1000 }), sprint.siteUrl),
    title: str(params, "title", { max: 300 }) ?? "",
  });
  return { pageId: id, sprintId: sprint.id };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export async function recordFinding(env: Env, companyId: string, actor: Actor, params: Params) {
  const sprint = await requireSprint(env, companyId, reqStr(params, "sprintId"));
  const url = str(params, "url", { max: 1000 });
  await db.upsertFinding(env.ctx.db, {
    id: randomUUID(),
    companyId,
    sprintId: sprint.id,
    finding: reqStr(params, "finding", { max: 1000 }),
    // Lenient for the legacy record-audit alias, which accepted any severity text.
    severity: (FINDING_SEVERITIES as readonly string[]).includes(String(params.severity ?? "")) ? String(params.severity) : "info",
    category: str(params, "category", { max: 40 }) ?? "manual",
    url: url ? urlParam(url, sprint.siteUrl) : null,
    source: actor.kind === "agent" ? "agent" : "manual",
  });
  return { sprintId: sprint.id, recorded: true };
}

export async function resolveFindingTool(env: Env, companyId: string, params: Params) {
  const id = reqStr(params, "findingId");
  const count = await db.resolveFinding(env.ctx.db, companyId, id);
  if (count === 0) throw new SeoError(`Finding ${id} was not found`);
  return { findingId: id, status: "resolved" };
}
