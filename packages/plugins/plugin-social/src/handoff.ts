/**
 * Hand-offs with other PiB plugins (kit HANDOFF_EVENTS).
 *
 * SEO → Social: `plugin.partnersinbiz.seo.content.published` opens one
 * repurpose task for the Social agent in the page's scope (kit
 * `receiveOnce`, plus a claimed row in `handoffs` so a retry never opens a
 * second issue). SEO re-emits the last 24 hours hourly.
 *
 * Social → CRM: inbox triage with intent "lead" emits `lead.captured`
 * (arrives as `plugin.partnersinbiz.social.lead.captured`). Delivery is at
 * most once, so leads from the last 24 hours are re-emitted hourly; the CRM
 * dedupes on the key.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  HANDOFF_EVENTS,
  PIB_PLUGINS,
  pluginEvent,
  receiveOnce,
  resolveCrmClient,
  isClientKind,
  type ContentPublished,
  type LeadCaptured,
} from "@partnersinbiz/pib-plugin-kit";
import { clientPrefix } from "./clients.js";
import { loadSocialConfig } from "./config.js";
import { iso, table, type InboxItemRow } from "./db.js";
import { clip } from "./domain.js";
import { createIssueSafely, ORIGIN_KIND, scopeLine, socialAgent, socialProjectId } from "./issues.js";
import { socialOn } from "./modules.js";

export const CONTENT_PUBLISHED_EVENT = pluginEvent(PIB_PLUGINS.seo, HANDOFF_EVENTS.contentPublished);
export const LEAD_TEXT_LIMIT = 300;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() ? clip(value.trim(), max) : null;
}

/** A usable payload, or null. Only http(s) URLs are accepted. */
export function parseContentPublished(payload: unknown): ContentPublished | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const key = text(p.key, 200);
  const url = text(p.url, 1000);
  if (!key || !url || !/^https?:\/\//i.test(url)) return null;
  const clientKind = isClientKind(p.clientKind) ? p.clientKind : null;
  const clientRef = clientKind ? text(p.clientRef, 200) : null;
  return {
    key,
    url,
    title: text(p.title, 300) ?? url,
    summary: text(p.summary, 1000),
    keyword: text(p.keyword, 200),
    clientKind: clientRef ? clientKind : null,
    clientRef,
    publishedAt: text(p.publishedAt, 40) ?? new Date().toISOString(),
  };
}

function withUtm(url: string, source: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("utm_source", source);
    u.searchParams.set("utm_medium", "social");
    u.searchParams.set("utm_campaign", "seo-repurpose");
    return u.toString();
  } catch {
    return url;
  }
}

/** Issue text for the Social agent. Pure. */
export function repurposeDescription(content: ContentPublished, row: { client_kind: string | null; client_ref: string | null; client_name: string | null }): string {
  return [
    `A new page went live from the SEO sprint: **${content.title}**`,
    "",
    `URL: ${content.url}`,
    content.keyword ? `Target keyword: ${content.keyword}` : null,
    content.summary ? `Summary: ${content.summary}` : null,
    "",
    scopeLine(row),
    "",
    "Draft these, in this scope, following the scope's Growth Lab playbook (`get-playbook` first):",
    `1. A LinkedIn post that gives the page's main point and links to it (${withUtm(content.url, "linkedin")}).`,
    `2. An X thread (3–6 posts) with the link in the last post (${withUtm(content.url, "x")}).`,
    "3. An Instagram idea: the visual, the caption and where the link goes (bio link or story), as a draft post.",
    "",
    "Rules:",
    "- Drafts only: `create-post`, then `request-review`. Never approve or schedule; a person approves every post.",
    "- Use only facts from the page. No new claims or numbers.",
    "- Use only this scope's accounts and media. Attach an account only when the scope has one for that platform.",
    "- Close this issue with the post ids you drafted.",
    "",
    `Hand-off key: \`${content.key}\``,
  ].filter((line): line is string => line !== null).join("\n");
}

async function defaultPerson(ctx: PluginContext, companyId: string): Promise<string | undefined> {
  try {
    return (await ctx.companies.get(companyId))?.defaultResponsibleUserId ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * One repurpose issue per key. Claims the key first; a claim older than ten
 * minutes without an issue (a crash between claim and create) is taken over.
 */
export async function openRepurposeTask(ctx: PluginContext, companyId: string, content: ContentPublished): Promise<{ issueId: string; created: boolean }> {
  const claim = await ctx.db.execute(
    `INSERT INTO ${table(ctx, "handoffs")} AS h (key, company_id, kind, payload) VALUES ($1, $2, 'repurpose', $3::jsonb)
     ON CONFLICT (key) DO UPDATE SET claimed_at = now()
      WHERE h.issue_id IS NULL AND h.claimed_at < now() - interval '10 minutes'`,
    [content.key, companyId, JSON.stringify(content)],
  );
  if ((claim.rowCount ?? 0) === 0) {
    const rows = await ctx.db.query<{ issue_id: string | null }>(
      `SELECT issue_id FROM ${table(ctx, "handoffs")} WHERE key = $1 AND company_id = $2 LIMIT 1`,
      [content.key, companyId],
    );
    if (rows[0]?.issue_id) return { issueId: rows[0].issue_id, created: false };
    // Another run holds the claim: throw so nothing is stored and a re-delivery tries again.
    throw new Error("Repurpose task is being opened by another run");
  }
  let clientName: string | null = null;
  if (content.clientKind && content.clientRef) {
    try {
      clientName = (await resolveCrmClient(ctx, ctx.db.namespace, companyId, { kind: content.clientKind, id: content.clientRef }))?.name ?? null;
    } catch {
      clientName = null;
    }
  }
  const row = { client_kind: content.clientKind ?? null, client_ref: content.clientRef ?? null, client_name: clientName };
  const agent = await socialAgent(ctx, companyId);
  const issue = await createIssueSafely(ctx, {
    companyId,
    projectId: await socialProjectId(ctx, companyId),
    title: `${clientPrefix(row)}Repurpose for social: ${clip(content.title, 120)}`,
    description: repurposeDescription(content, row),
    priority: "medium",
    originKind: ORIGIN_KIND,
    originId: `repurpose:${content.key}`,
    assigneeAgentId: agent.active && agent.agentId ? agent.agentId : undefined,
    assigneeUserId: agent.active ? undefined : await defaultPerson(ctx, companyId),
    wakeReason: "New SEO page to repurpose",
  });
  await ctx.db.execute(`UPDATE ${table(ctx, "handoffs")} SET issue_id = $3 WHERE key = $1 AND company_id = $2`, [content.key, companyId, issue.id]);
  return { issueId: issue.id, created: true };
}

export async function onContentPublished(ctx: PluginContext, event: PluginEvent): Promise<{ issueId: string } | null> {
  const companyId = event.companyId;
  const content = parseContentPublished(event.payload);
  if (!companyId || !content) return null;
  // Off, or settings never saved: skip without storing, so a later re-emit can still land.
  if (!(await socialOn(ctx, companyId))) return null;
  if (!(await loadSocialConfig(ctx, companyId)).saved) return null;
  const { result } = await receiveOnce(ctx, companyId, CONTENT_PUBLISHED_EVENT, content.key, async () => {
    const opened = await openRepurposeTask(ctx, companyId, content);
    return { issueId: opened.issueId };
  });
  return { issueId: String(result.issueId) };
}

export function registerHandoffs(ctx: PluginContext): void {
  ctx.events.on(CONTENT_PUBLISHED_EVENT, async (event: PluginEvent) => {
    try {
      await onContentPublished(ctx, event);
    } catch (error) {
      ctx.logger.info("Social repurpose hand-off failed; SEO re-emits it", { error: errorMessage(error) });
    }
  });
}

// ── leads (Social → CRM) ────────────────────────────────────────────────────

type LeadItem = Pick<InboxItemRow, "id" | "platform" | "author" | "body" | "permalink" | "client_kind" | "client_ref" | "received_at" | "created_at">;

export function leadPayload(item: LeadItem, confidence: number | null): LeadCaptured {
  const clientKind = isClientKind(item.client_kind) && item.client_ref ? item.client_kind : null;
  return {
    key: `social:inbox:${item.id}`,
    source: "social",
    name: item.author || null,
    email: null,
    handle: item.author || null,
    platform: item.platform ?? null,
    text: clip(item.body.trim(), LEAD_TEXT_LIMIT),
    url: item.permalink ?? null,
    clientKind,
    clientRef: clientKind ? item.client_ref : null,
    confidence: typeof confidence === "number" && Number.isFinite(confidence) ? confidence : null,
    capturedAt: iso(item.received_at) ?? iso(item.created_at) ?? new Date().toISOString(),
  };
}

/** Emit one lead. Best effort: a missed emit is re-sent by the hourly job. */
export async function emitLead(ctx: PluginContext, companyId: string, item: LeadItem, confidence: number | null): Promise<boolean> {
  try {
    await ctx.events.emit(HANDOFF_EVENTS.leadCaptured, companyId, leadPayload(item, confidence) as unknown as Record<string, unknown>);
    return true;
  } catch (error) {
    ctx.logger.info("Social lead emit failed", { itemId: item.id, error: errorMessage(error) });
    return false;
  }
}

/** Hourly: re-emit leads triaged in the last 24 hours (the CRM receives each key once). */
export async function reemitRecentLeads(ctx: PluginContext, companyId: string): Promise<number> {
  const rows = await ctx.db.query<LeadItem & { confidence: string | null }>(
    `SELECT id, platform, author, body, permalink, client_kind, client_ref, received_at, created_at,
            CASE WHEN triage->'corrected'->>'intent' = 'lead' THEN '1' ELSE triage->'intent'->>'confidence' END AS confidence
       FROM ${table(ctx, "inbox_items")}
      WHERE company_id = $1 AND triaged_at >= now() - interval '24 hours'
        AND COALESCE(triage->'corrected'->>'intent', triage->'intent'->>'value') = 'lead'
        AND COALESCE(triage->>'action', '') <> 'escalated'
      ORDER BY triaged_at LIMIT 100`,
    [companyId],
  );
  let sent = 0;
  for (const row of rows) if (await emitLead(ctx, companyId, row, row.confidence == null ? null : Number(row.confidence))) sent += 1;
  return sent;
}
