/**
 * SEO → Social hand-off: `content.published` (kit
 * `HANDOFF_EVENTS.contentPublished`, payload `ContentPublished`). It arrives
 * at Social as `plugin.partnersinbiz.seo.content.published`; Social opens one
 * repurpose task per key (`seo:content:<id>`) with `receiveOnce`.
 *
 * It goes out only once the change is live:
 * - a content row marked live, or a finished publish task, is queued as an
 *   announcement (one row per key);
 * - a sign-off approved with a pull request waits for its merge task;
 * - the page must answer 200 (fetched through the SSRF-guarded site fetcher);
 * - the payload carries the page's own summary (its meta description).
 * Checks back off (10 minutes up to 6 hours). Three days without a 200 makes
 * it stuck: the Cockpit shows it and `today` tells the SEO agent, and it is
 * still checked daily. Events arrive at most once, so a sent key is re-sent
 * hourly for 24 hours; Social dedupes the key.
 */
import { HANDOFF_EVENTS, type ContentPublished } from "@partnersinbiz/pib-plugin-kit";
import { bodyText, decodeEntities, extractMeta } from "../checks/parse.js";
import * as db from "../db.js";
import { isRehearsalSprint } from "../engine/rehearsal.js";
import { errorMessage, type Env } from "./common.js";

/** Task types whose completion means a page or post went live. */
export const PUBLISH_TASK_TYPES = new Set(["post-publish", "pillar-publish", "cluster-publish", "pseo-comparison", "pseo-feature"]);

/** Minutes before check n+1 (then every 6 hours). */
export const RECHECK_MINUTES = [10, 20, 30, 60, 120, 240, 360];
/** Hours without a 200 before an announcement counts as stuck. */
export const STUCK_AFTER_HOURS = 72;
/** How long one page check may take. */
const CHECK_TIMEOUT_MS = 15_000;
const SUMMARY_MAX = 300;

type SprintScope = Pick<db.Sprint, "siteUrl" | "clientKind" | "clientRef">;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** The first evidence link on the sprint's own site (not the repo or a PR). Pure. */
export function liveUrlFromEvidence(task: Pick<db.SprintTask, "evidence">, siteUrl: string): string | null {
  const site = hostOf(siteUrl);
  if (!site) return null;
  const evidence = (task.evidence ?? {}) as { links?: unknown; handoff?: { links?: unknown } };
  const links = [...(Array.isArray(evidence.links) ? evidence.links : []), ...(Array.isArray(evidence.handoff?.links) ? evidence.handoff!.links as unknown[] : [])];
  for (const link of links) {
    if (typeof link !== "string" || !/^https?:\/\//i.test(link)) continue;
    const host = hostOf(link);
    if (host && (host === site || host.endsWith(`.${site}`))) return link;
  }
  return null;
}

function publishedAt(date: string | null): string {
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : new Date().toISOString();
}

function clip(value: string, max: number): string {
  const chars = Array.from(value.replace(/\s+/g, " ").trim());
  if (chars.length <= max) return chars.join("");
  const cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * What the live page says it is about: its meta description, else its
 * og:description, else its first real paragraph. Pure.
 */
export function pageSummary(html: string): string | null {
  const meta = extractMeta(html);
  for (const text of [meta.description, meta.ogDescription]) {
    if (text && text.trim().length >= 20) return clip(decodeEntities(text), SUMMARY_MAX);
  }
  const main = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2] ?? html;
  for (const match of main.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const text = bodyText(match[1]!);
    if (text.length >= 60) return clip(decodeEntities(text), SUMMARY_MAX);
  }
  return null;
}

/** Payload for a live content row. Pure. */
export function contentPayload(
  content: Pick<db.ContentItem, "id" | "title" | "targetUrl" | "publishedOn">,
  sprint: SprintScope,
  keyword: string | null,
  summary: string | null = null,
): ContentPublished | null {
  if (!content.targetUrl) return null;
  return {
    key: `seo:content:${content.id}`,
    url: content.targetUrl,
    title: content.title,
    summary,
    keyword,
    clientKind: sprint.clientRef ? sprint.clientKind : null,
    clientRef: sprint.clientRef ?? null,
    publishedAt: publishedAt(content.publishedOn),
  };
}

export async function emitContentPublished(env: Env, companyId: string, payload: ContentPublished): Promise<boolean> {
  try {
    await env.ctx.events.emit(HANDOFF_EVENTS.contentPublished, companyId, payload as unknown as Record<string, unknown>);
    return true;
  } catch (error) {
    env.ctx.logger.info("SEO content.published emit failed; the hourly run sends it again", { key: payload.key, error: errorMessage(error) });
    return false;
  }
}

async function keywordPhrase(env: Env, companyId: string, keywordId: string | null): Promise<string | null> {
  if (!keywordId) return null;
  try {
    return (await db.getKeyword(env.ctx.db, companyId, keywordId))?.phrase ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

export interface AnnounceResult {
  key: string;
  status: db.AnnouncementStatus;
  /** Why it has not gone out yet (waiting, stuck, dropped). */
  reason: string | null;
}

function minutesFrom(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

/** When to check again after `checks` checks. Pure. */
export function nextCheckMinutes(checks: number): number {
  return RECHECK_MINUTES[Math.min(Math.max(checks, 0), RECHECK_MINUTES.length - 1)]!;
}

async function checkPage(env: Env, url: string): Promise<{ status: number; html: string } | { error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      env.site(url, { maxChars: 400_000 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`No answer within ${CHECK_TIMEOUT_MS / 1000} s`)), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { status: res.status, html: res.text };
  } catch (error) {
    return { error: errorMessage(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Target {
  url: string;
  title: string;
  keyword: string | null;
  publishedAt: string;
  sprint: db.Sprint;
}

/** What an announcement points at, or why it cannot go out (drop: no longer applies). */
async function resolveTarget(env: Env, a: db.Announcement): Promise<{ target: Target } | { wait: string } | { drop: string }> {
  const sprint = await db.getSprint(env.ctx.db, a.companyId, a.sprintId);
  if (!sprint) return { drop: "The sprint no longer exists." };
  // A rehearsal sprint's pages are fixtures: Social (and so a person and an agent) is never told about them.
  if (isRehearsalSprint(sprint)) return { drop: "This is a rehearsal sprint: Social is never told about its pages." };
  const task = a.taskId ? await db.getTask(env.ctx.db, a.companyId, a.taskId) : null;
  if (a.taskId && task && task.status !== "done") return { drop: "The publish task is not done any more." };
  if (a.contentId) {
    const content = await db.getContent(env.ctx.db, a.companyId, a.contentId);
    if (!content) return { drop: "The content row was deleted." };
    // A row queued as live that was moved back is no longer announced; one queued from its publish task only needs its URL.
    if (!a.taskId && content.status !== "live") return { drop: "The content row is no longer marked live." };
    if (!content.targetUrl) return { wait: "The content row has no live URL yet: set it with update-content (targetUrl)." };
    return {
      target: {
        url: content.targetUrl,
        title: content.title,
        keyword: await keywordPhrase(env, a.companyId, content.targetKeywordId),
        publishedAt: publishedAt(content.publishedOn ?? task?.completedAt?.slice(0, 10) ?? null),
        sprint,
      },
    };
  }
  if (!task) return { drop: "The publish task no longer exists." };
  const merge = a.waitTaskId ? await db.getTask(env.ctx.db, a.companyId, a.waitTaskId) : null;
  const url = liveUrlFromEvidence(task, sprint.siteUrl) ?? (merge ? liveUrlFromEvidence(merge, sprint.siteUrl) : null);
  if (!url) return { wait: "No live URL yet: mark the page's content row live with its URL (update-content), or put the live URL in the task's evidence." };
  return { target: { url, title: task.title, keyword: null, publishedAt: task.completedAt ?? new Date().toISOString(), sprint } };
}

/**
 * Check one announcement and send it when the change is live. Never throws.
 * Updates the row: sent, waiting (next check backs off), stuck or dropped.
 */
export async function processAnnouncement(env: Env, a: db.Announcement): Promise<AnnounceResult> {
  const now = env.now();
  const store = env.announcements;
  const wait = async (reason: string, httpStatus: number | null = null, url?: string): Promise<AnnounceResult> => {
    const queued = a.queuedAt ? Date.parse(a.queuedAt) : now.getTime();
    const stuck = now.getTime() - queued >= STUCK_AFTER_HOURS * 3600_000;
    await store.update(a.companyId, a.key, {
      status: stuck ? "stuck" : "waiting",
      checks: a.checks + 1,
      last_http_status: httpStatus,
      last_error: reason.slice(0, 500),
      next_check_at: minutesFrom(now, stuck ? 24 * 60 : nextCheckMinutes(a.checks)),
      ...(url ? { url } : {}),
    });
    return { key: a.key, status: stuck ? "stuck" : "waiting", reason };
  };
  try {
    if (a.waitTaskId) {
      const merge = await db.getTask(env.ctx.db, a.companyId, a.waitTaskId);
      if (merge?.status === "skipped") {
        await store.update(a.companyId, a.key, { status: "dropped", last_error: "The merge task for the approved PR was skipped, so the change never went live." });
        return { key: a.key, status: "dropped", reason: "The merge task was skipped." };
      }
      if (merge && merge.status !== "done") return await wait(`Waiting for the approved PR to be merged ("${merge.title}").`);
    }
    const resolved = await resolveTarget(env, a);
    if ("drop" in resolved) {
      await store.update(a.companyId, a.key, { status: "dropped", last_error: resolved.drop });
      return { key: a.key, status: "dropped", reason: resolved.drop };
    }
    if ("wait" in resolved) return await wait(resolved.wait);
    const { target } = resolved;
    const page = await checkPage(env, target.url);
    if ("error" in page) return await wait(`It could not be fetched: ${page.error}.`, null, target.url);
    if (page.status !== 200) return await wait(`It answers ${page.status}, not 200: the deploy may not be done.`, page.status, target.url);
    const payload: ContentPublished = {
      key: a.key,
      url: target.url,
      title: target.title,
      summary: pageSummary(page.html),
      keyword: target.keyword,
      clientKind: target.sprint.clientRef ? target.sprint.clientKind : null,
      clientRef: target.sprint.clientRef ?? null,
      publishedAt: target.publishedAt,
    };
    if (!(await emitContentPublished(env, a.companyId, payload))) return await wait("Sending to Social failed; retried shortly.", 200, target.url);
    await store.update(a.companyId, a.key, {
      status: "sent",
      url: target.url,
      checks: a.checks + 1,
      last_http_status: 200,
      last_error: null,
      payload,
      sent_at: now.toISOString(),
    });
    return { key: a.key, status: "sent", reason: null };
  } catch (error) {
    env.ctx.logger.info("SEO announcement check failed; retried later", { key: a.key, error: errorMessage(error) });
    return { key: a.key, status: a.status, reason: errorMessage(error) };
  }
}

async function queueAndCheck(env: Env, companyId: string, input: { key: string; sprintId: string; contentId: string | null; taskId: string | null; waitTaskId: string | null }): Promise<AnnounceResult | null> {
  await env.announcements.queue({ companyId, ...input });
  const row = await env.announcements.get(companyId, input.key);
  if (!row) return null;
  if (row.status === "sent") return { key: row.key, status: "sent", reason: null };
  return processAnnouncement(env, row);
}

/** A content row was marked live: announce it once the page answers 200. Never throws. */
export async function contentWentLive(env: Env, companyId: string, contentId: string): Promise<AnnounceResult | null> {
  try {
    const content = await db.getContent(env.ctx.db, companyId, contentId);
    if (!content || content.status !== "live" || !content.targetUrl) return null;
    return await queueAndCheck(env, companyId, { key: `seo:content:${content.id}`, sprintId: content.sprintId, contentId: content.id, taskId: null, waitTaskId: null });
  } catch (error) {
    env.ctx.logger.info("SEO content hand-off skipped", { contentId, error: errorMessage(error) });
    return null;
  }
}

/**
 * A publish task finished (complete-task, or a person closed its sign-off
 * issue). With `waitTaskId` (the merge task of an approved PR) it waits for
 * that merge. Only publish task types are announced. Never throws.
 */
export async function publishTaskDone(env: Env, companyId: string, taskId: string, waitTaskId: string | null = null): Promise<AnnounceResult | null> {
  try {
    const task = await db.getTask(env.ctx.db, companyId, taskId);
    if (!task || task.status !== "done" || !PUBLISH_TASK_TYPES.has(task.taskType)) return null;
    const rows = await env.ctx.db.query<{ id: string }>(
      `SELECT id FROM ${db.t("content")} WHERE company_id = $1 AND sprint_id = $2 AND task_id = $3 AND target_url IS NOT NULL ORDER BY created_at LIMIT 1`,
      [task.companyId, task.sprintId, task.id],
    );
    const contentId = rows[0]?.id ?? null;
    return await queueAndCheck(env, companyId, {
      key: contentId ? `seo:content:${contentId}` : `seo:content:task-${task.id}`,
      sprintId: task.sprintId,
      contentId,
      taskId: task.id,
      waitTaskId,
    });
  } catch (error) {
    env.ctx.logger.info("SEO publish-task hand-off skipped", { taskId, error: errorMessage(error) });
    return null;
  }
}

/** A task finished: announcements waiting (or stuck) on it, because it merged an approved PR, are checked now. */
export async function releaseAnnouncements(env: Env, companyId: string, doneTaskId: string): Promise<number> {
  let sent = 0;
  try {
    for (const row of await env.announcements.waitingOn(companyId, doneTaskId)) {
      if ((await processAnnouncement(env, row)).status === "sent") sent += 1;
    }
  } catch (error) {
    env.ctx.logger.info("SEO waiting announcements not checked", { taskId: doneTaskId, error: errorMessage(error) });
  }
  return sent;
}

/**
 * Hourly: check due announcements (sending the live ones) and re-send what
 * went out in the last 24 hours. Returns how many were sent or re-sent.
 */
export async function processAnnouncements(env: Env, companyId: string): Promise<{ sent: number; waiting: number; stuck: number; resent: number }> {
  const out = { sent: 0, waiting: 0, stuck: 0, resent: 0 };
  const justSent = new Set<string>();
  for (const row of await env.announcements.due(companyId, 20)) {
    const result = await processAnnouncement(env, row);
    if (result.status === "sent") {
      out.sent += 1;
      justSent.add(row.key);
    } else if (result.status === "stuck") out.stuck += 1;
    else if (result.status === "waiting") out.waiting += 1;
  }
  for (const row of await env.announcements.recentlySent(companyId)) {
    const payload = row.payload as ContentPublished | null;
    if (justSent.has(row.key) || !payload?.key) continue;
    if (await emitContentPublished(env, companyId, payload)) out.resent += 1;
  }
  return out;
}

/** One line for `today` and the Cockpit about an announcement that has not gone out. Pure. */
export function announcementLine(a: Pick<db.Announcement, "key" | "status" | "lastError" | "url">): string {
  const what = a.url ? `${a.url}` : a.key;
  return a.status === "stuck"
    ? `Social has not been told about ${what}: ${a.lastError ?? "it is not live yet"} Fix the URL or the deploy (update-content targetUrl), then it goes out on the next check.`
    : `Waiting to tell Social about ${what}: ${a.lastError ?? "checking that it is live"}`;
}
