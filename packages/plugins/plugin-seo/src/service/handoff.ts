/**
 * SEO → Social hand-off: when a page or post goes live, emit
 * `content.published` (kit `HANDOFF_EVENTS.contentPublished`, payload
 * `ContentPublished`). It arrives at Social as
 * `plugin.partnersinbiz.seo.content.published`; Social opens one repurpose
 * task per key (`seo:content:<id>`) with `receiveOnce`.
 *
 * Events are delivered at most once, so the hourly daily-job run re-emits
 * everything that went live in the last 24 hours. Social dedupes on the key.
 */
import { HANDOFF_EVENTS, type ContentPublished } from "@partnersinbiz/pib-plugin-kit";
import * as db from "../db.js";
import { errorMessage, type Env } from "./common.js";

/** Task types whose completion means a page or post went live. */
export const PUBLISH_TASK_TYPES = new Set(["post-publish", "pillar-publish", "cluster-publish", "pseo-comparison", "pseo-feature"]);

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

/** Payload for a live content row. Pure. */
export function contentPayload(content: Pick<db.ContentItem, "id" | "title" | "targetUrl" | "publishedOn">, sprint: SprintScope, keyword: string | null): ContentPublished | null {
  if (!content.targetUrl) return null;
  return {
    key: `seo:content:${content.id}`,
    url: content.targetUrl,
    title: content.title,
    summary: null,
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
    env.ctx.logger.info("SEO content.published emit failed; the hourly run re-emits it", { key: payload.key, error: errorMessage(error) });
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

/** A content row went live. Best effort; never throws. */
export async function contentWentLive(env: Env, companyId: string, contentId: string): Promise<boolean> {
  try {
    const content = await db.getContent(env.ctx.db, companyId, contentId);
    if (!content || content.status !== "live") return false;
    const sprint = await db.getSprint(env.ctx.db, companyId, content.sprintId);
    if (!sprint) return false;
    const payload = contentPayload(content, sprint, await keywordPhrase(env, companyId, content.targetKeywordId));
    return payload ? emitContentPublished(env, companyId, payload) : false;
  } catch (error) {
    env.ctx.logger.info("SEO content hand-off skipped", { contentId, error: errorMessage(error) });
    return false;
  }
}

/** Payload for a finished publish task (its content row when one points at it). */
async function taskPayload(env: Env, task: db.SprintTask, sprint: db.Sprint): Promise<ContentPublished | null> {
  if (!PUBLISH_TASK_TYPES.has(task.taskType)) return null;
  const rows = await env.ctx.db.query<{ id: string }>(
    `SELECT id FROM ${db.t("content")} WHERE company_id = $1 AND sprint_id = $2 AND task_id = $3 AND target_url IS NOT NULL ORDER BY created_at LIMIT 1`,
    [task.companyId, task.sprintId, task.id],
  );
  if (rows[0]) {
    const content = await db.getContent(env.ctx.db, task.companyId, rows[0].id);
    if (content?.targetUrl) return contentPayload({ ...content, publishedOn: content.publishedOn ?? task.completedAt?.slice(0, 10) ?? null }, sprint, await keywordPhrase(env, task.companyId, content.targetKeywordId));
  }
  const url = liveUrlFromEvidence(task, sprint.siteUrl);
  if (!url) return null;
  return {
    key: `seo:content:task-${task.id}`,
    url,
    title: task.title,
    summary: null,
    keyword: null,
    clientKind: sprint.clientRef ? sprint.clientKind : null,
    clientRef: sprint.clientRef ?? null,
    publishedAt: task.completedAt ?? new Date().toISOString(),
  };
}

/** A publish task finished (complete-task or its issue closed). Best effort; never throws. */
export async function publishTaskDone(env: Env, companyId: string, taskId: string): Promise<boolean> {
  try {
    const task = await db.getTask(env.ctx.db, companyId, taskId);
    if (!task || task.status !== "done" || !PUBLISH_TASK_TYPES.has(task.taskType)) return false;
    const sprint = await db.getSprint(env.ctx.db, companyId, task.sprintId);
    if (!sprint) return false;
    const payload = await taskPayload(env, task, sprint);
    return payload ? emitContentPublished(env, companyId, payload) : false;
  } catch (error) {
    env.ctx.logger.info("SEO publish-task hand-off skipped", { taskId, error: errorMessage(error) });
    return false;
  }
}

/** Hourly: re-emit what went live in the last 24 hours (content rows and publish tasks). */
export async function reemitRecentContent(env: Env, companyId: string): Promise<number> {
  const sent = new Set<string>();
  const content = await env.ctx.db.query<{ id: string }>(
    `SELECT id FROM ${db.t("content")}
      WHERE company_id = $1 AND status = 'live' AND target_url IS NOT NULL AND updated_at >= now() - interval '24 hours'
      ORDER BY updated_at LIMIT 50`,
    [companyId],
  );
  for (const row of content) {
    const item = await db.getContent(env.ctx.db, companyId, row.id);
    const sprint = item ? await db.getSprint(env.ctx.db, companyId, item.sprintId) : null;
    const payload = item && sprint ? contentPayload(item, sprint, await keywordPhrase(env, companyId, item.targetKeywordId)) : null;
    if (payload && !sent.has(payload.key) && (await emitContentPublished(env, companyId, payload))) sent.add(payload.key);
  }
  const tasks = await env.ctx.db.query<{ id: string }>(
    `SELECT id FROM ${db.t("sprint_tasks")}
      WHERE company_id = $1 AND status = 'done' AND completed_at >= now() - interval '24 hours'
        AND task_type IN (SELECT jsonb_array_elements_text($2::jsonb))
      ORDER BY completed_at LIMIT 50`,
    [companyId, JSON.stringify([...PUBLISH_TASK_TYPES])],
  );
  for (const row of tasks) {
    const task = await db.getTask(env.ctx.db, companyId, row.id);
    const sprint = task ? await db.getSprint(env.ctx.db, companyId, task.sprintId) : null;
    const payload = task && sprint ? await taskPayload(env, task, sprint) : null;
    if (payload && !sent.has(payload.key) && (await emitContentPublished(env, companyId, payload))) sent.add(payload.key);
  }
  return sent.size;
}
