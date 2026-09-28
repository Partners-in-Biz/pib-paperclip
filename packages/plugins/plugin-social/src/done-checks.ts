/**
 * Done-checks (kit `registerDoneChecks`): when an AGENT marks one of Social's
 * work issues done, the plugin checks the outcome in its own tables. If the
 * work is not finished, the issue is reopened with what is missing and the
 * agent is woken; the third early close goes to the Operator. A person's
 * close is never checked.
 *
 * | origin id                               | done when                                                       |
 * |-----------------------------------------|-----------------------------------------------------------------|
 * | `repurpose:<hand-off key>`              | a post for that page exists in its scope (linked or listing it) |
 * | `schedule:<scope>:<postId>`             | no approved post in that scope is left without a time           |
 * | `account:<accountId>` (reconnect)       | the account is connected again (or was disconnected or removed) |
 * | `inbox:<accountId>:<day>` (reply queue) | every comment on it is replied to or needs no reply             |
 * | `post-failed:<postId>`                  | no destination of the post is still failed                      |
 *
 * Each check also passes when the issue is not Social's (another plugin can
 * use the same words in its origin ids): it only reads rows that belong to it.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { ASK_OWNER_TOOL, parseClientParam, type DoneCheckIssue, type DoneCheckResult, type DoneCheckRule } from "@partnersinbiz/pib-plugin-kit";
import { destinationsForPost, getAccount, getAccountsByIds, getPost, table } from "./db.js";
import { clip } from "./domain.js";
import { SOCIAL_ORIGINS } from "./issues.js";
import { isSocialPlatform, PLATFORM_LABELS } from "./platforms.js";

export { SOCIAL_ORIGINS };

/**
 * An inbox item that still needs a reply: new, not spam or escalated to a
 * person, and not marked "no reply needed" (the Cockpit's "Inbox needing a
 * reply" counts the same). Columns of `inbox_items`, optionally aliased.
 */
export function needsReplySql(alias = ""): string {
  const a = alias ? `${alias}.` : "";
  return `${a}status = 'new'
    AND COALESCE(${a}triage->>'action', '') NOT IN ('spam_read', 'escalated')
    AND (${a}triage IS NULL OR COALESCE(${a}triage->'corrected'->>'needs_reply', CASE WHEN ${a}triage->'needsReply'->>'yes' = 'true' THEN 'yes' ELSE 'no' END) = 'yes')`;
}

/**
 * A failed publish: the post failed (or partly published) and a destination
 * is still failed, so nobody retried it, detached it or moved the post back.
 * Columns of `posts` under alias `p`; `destinations` table given.
 */
export function failedPublishSql(destinations: string): string {
  return `p.status IN ('failed', 'partially_published') AND EXISTS (SELECT 1 FROM ${destinations} d WHERE d.post_id = p.id AND d.status = 'failed')`;
}

/**
 * What a draft for a page must contain: the page's host (without www.) and
 * path, lowercased, with no query or trailing slash. Empty when the URL does
 * not parse. Pure.
 */
export function pageNeedle(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "").toLowerCase();
    return `${host}${path}`;
  } catch {
    return "";
  }
}

export interface RepurposeRef {
  /** Hand-off key (`seo:content:<id>`), stored on linked drafts as `source_ref`. */
  key: string;
  /** The page's client ref, or "" for own work. */
  ref: string;
  needle: string;
}

/**
 * Posts drafted for each repurposed page, in its scope: linked to it
 * (`create-post` with `handoffKey`) or listing its URL in the text, first
 * comment or overrides. Any status counts: a draft that went on to be
 * approved or published was drafted. One query for all pages.
 */
export async function repurposeDraftCounts(ctx: PluginContext, companyId: string, refs: RepurposeRef[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (refs.length === 0) return out;
  const rows = await ctx.db.query<{ key: string; drafts: number | string }>(
    `SELECT x.key,
            (SELECT count(*) FROM ${table(ctx, "posts")} p
              WHERE p.company_id = $1 AND COALESCE(p.client_ref, '') = x.ref
                AND (p.source_ref = x.key
                     OR (x.needle <> '' AND position(x.needle in lower(p.body || ' ' || COALESCE(p.first_comment, '') || ' ' || p.overrides::text)) > 0)))::int AS drafts
       FROM jsonb_to_recordset($2::jsonb) AS x(key text, ref text, needle text)`,
    [companyId, JSON.stringify(refs)],
  );
  for (const row of rows) out.set(String(row.key), Number(row.drafts ?? 0));
  return out;
}

export interface HandoffPayload {
  key?: string;
  url?: string;
  title?: string;
  clientKind?: string | null;
  clientRef?: string | null;
}

/** A hand-off row's payload (the SEO `content.published` event). */
export function handoffPayload(value: unknown): HandoffPayload {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as HandoffPayload;
    } catch {
      return {};
    }
  }
  return value as HandoffPayload;
}

export function repurposeRef(key: string, payload: HandoffPayload): RepurposeRef {
  return { key, ref: payload.clientRef ?? "", needle: pageNeedle(payload.url) };
}

function platformName(platform: string): string {
  return isSocialPlatform(platform) ? PLATFORM_LABELS[platform] : platform;
}

function snippet(text: string, max = 60): string {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}

/** How to pass the scope to the tools, for a missing line: `, client: "company:<id>"` or nothing for own work. */
function clientArg(clientKind: string | null | undefined, clientRef: string | null | undefined): string {
  return clientRef ? `, \`client: "${clientKind === "contact" ? "contact" : "company"}:${clientRef}"\`` : "";
}

// ── the checks ─────────────────────────────────────────────────────────────

/** Repurpose task: a draft exists for the page, in its scope. */
export async function checkRepurpose(issue: DoneCheckIssue, ctx: PluginContext): Promise<DoneCheckResult> {
  const key = (issue.originId ?? "").slice(SOCIAL_ORIGINS.repurpose.length);
  const rows = await ctx.db.query<{ key: string; payload: unknown }>(
    `SELECT key, payload FROM ${table(ctx, "handoffs")} WHERE company_id = $1 AND kind = 'repurpose' AND (issue_id = $2 OR key = $3) LIMIT 1`,
    [issue.companyId, issue.id, key],
  );
  const handoff = rows[0];
  if (!handoff) return { done: true };
  const payload = handoffPayload(handoff.payload);
  const drafts = (await repurposeDraftCounts(ctx, issue.companyId, [repurposeRef(handoff.key, payload)])).get(handoff.key) ?? 0;
  if (drafts > 0) return { done: true };
  return {
    done: false,
    missing: [
      `No draft posts for "${snippet(payload.title ?? payload.url ?? "the page", 80)}" yet: draft them with \`create-post\` (\`handoffKey: "${handoff.key}"\`${clientArg(payload.clientKind, payload.clientRef)}), then \`request-review\`, and close this issue with the post ids.`,
    ],
  };
}

/** "Schedule approved social posts": no approved post in the task's scope is left without a time. */
export async function checkSchedule(issue: DoneCheckIssue, ctx: PluginContext): Promise<DoneCheckResult> {
  const rest = (issue.originId ?? "").slice(SOCIAL_ORIGINS.schedule.length);
  const cut = rest.lastIndexOf(":");
  const scopeKey = cut > 0 ? rest.slice(0, cut) : "";
  const postId = cut > 0 ? rest.slice(cut + 1) : rest;
  const posts = table(ctx, "posts");
  const mine = await ctx.db.query<{ id: string }>(`SELECT id FROM ${posts} WHERE company_id = $1 AND (id = $2 OR schedule_issue_id = $3) LIMIT 1`, [issue.companyId, postId, issue.id]);
  if (!mine[0]) return { done: true };
  const scope = scopeKey === "own" ? null : parseClientParam(scopeKey);
  if (scopeKey !== "own" && !scope) return { done: true };
  const approved = await ctx.db.query<{ id: string; body: string }>(
    `SELECT id, body FROM ${posts} WHERE company_id = $1 AND status = 'approved' AND COALESCE(client_ref, '') = $2 ORDER BY updated_at LIMIT 100`,
    [issue.companyId, scope?.id ?? ""],
  );
  if (approved.length === 0) return { done: true };
  const missing = approved.slice(0, 3).map((p) => `"${snippet(p.body)}" (post \`${p.id}\`) is approved but has no publish time: \`schedule-post\` it (or \`bulk-schedule\`), or move it back to draft.`);
  if (approved.length > 3) missing.push(`${approved.length - 3} more approved posts in this scope need a time (\`list-posts\` status approved).`);
  return { done: false, missing };
}

/** Reconnect: the account is connected again, or a person disconnected or removed it. */
export async function checkReconnect(issue: DoneCheckIssue, ctx: PluginContext): Promise<DoneCheckResult> {
  const account = await getAccount(ctx, issue.companyId, (issue.originId ?? "").slice(SOCIAL_ORIGINS.reconnect.length));
  if (!account || account.status === "disabled") return { done: true };
  if (account.token_enc && account.status === "connected") return { done: true };
  const label = `${platformName(account.platform)} · ${account.display_name}`;
  return {
    done: false,
    missing: [
      `${label} is still ${account.status === "expiring" ? "about to stop working" : "disconnected"}: a person signs in again on Social → Accounts (Reconnect). You cannot do this; keep this issue open for them, and ask once with \`${ASK_OWNER_TOOL}\` if no person has it.`,
    ],
  };
}

/** Reply queue: every comment on it is replied to, marked read, or needs no reply. */
export async function checkReplyQueue(issue: DoneCheckIssue, ctx: PluginContext): Promise<DoneCheckResult> {
  const open = await ctx.db.query<{ id: string; author: string | null; platform: string | null; body: string }>(
    `SELECT id, author, platform, body FROM ${table(ctx, "inbox_items")}
      WHERE company_id = $1 AND triage_issue_id = $2 AND ${needsReplySql()}
      ORDER BY COALESCE(received_at, created_at) LIMIT 100`,
    [issue.companyId, issue.id],
  );
  if (open.length === 0) return { done: true };
  const missing = open
    .slice(0, 3)
    .map((i) => `${i.author || "Someone"} on ${i.platform ? platformName(i.platform) : "social"}: "${snippet(i.body)}" (itemId \`${i.id}\`) has no reply yet: \`reply-inbox\`, or \`mark-inbox-read\` if it needs none.`);
  if (open.length > 3) missing.push(`${open.length - 3} more comments on this issue still need a reply (\`list-inbox\` status new).`);
  return { done: false, missing };
}

/** Failed post: no destination is still failed (retried, detached, or the post is back in draft). */
export async function checkPublishFailure(issue: DoneCheckIssue, ctx: PluginContext): Promise<DoneCheckResult> {
  const post = await getPost(ctx, issue.companyId, (issue.originId ?? "").slice(SOCIAL_ORIGINS.publishFailed.length));
  if (!post || (post.status !== "failed" && post.status !== "partially_published")) return { done: true };
  const failed = (await destinationsForPost(ctx, post.id)).filter((d) => d.status === "failed");
  if (failed.length === 0) return { done: true };
  const accounts = new Map((await getAccountsByIds(ctx, issue.companyId, failed.map((d) => d.account_id))).map((a) => [a.id, a]));
  const where = failed.map((d) => {
    const account = accounts.get(d.account_id);
    return `${account ? `${platformName(account.platform)} · ${account.display_name}` : `account ${d.account_id}`}${d.last_error ? ` (${clip(d.last_error, 120)})` : ""}`;
  });
  return {
    done: false,
    missing: [
      `"${snippet(post.body)}" (post \`${post.id}\`) is still failed on ${where.join("; ")}. Fix the cause and \`retry-post\`; or, when you drafted a corrected post instead, \`detach-destination\` that account from this one.`,
    ],
  };
}

export const SOCIAL_DONE_CHECKS: DoneCheckRule[] = [
  { originPrefix: SOCIAL_ORIGINS.repurpose, label: "Repurpose for social", check: checkRepurpose },
  { originPrefix: SOCIAL_ORIGINS.schedule, label: "Schedule approved social posts", check: checkSchedule },
  { originPrefix: SOCIAL_ORIGINS.reconnect, label: "Reconnect a social account", check: checkReconnect },
  { originPrefix: SOCIAL_ORIGINS.replyQueue, label: "Reply to social comments", check: checkReplyQueue },
  { originPrefix: SOCIAL_ORIGINS.publishFailed, label: "Failed social post", check: checkPublishFailure },
];

