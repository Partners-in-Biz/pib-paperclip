/**
 * Sign-off lock: a WordPress site whose SEO sprint has change policy pr_only is changed only after a person
 * says so. The SEO plugin sends `site.signoff` ({ siteId, required }) whenever it checks the policy and
 * `site.write-approved` when a person approves applying the signed-off changes. Agents' Connector writes are refused
 * while the lock is on and no grant allows the write; people are never blocked.
 *
 * Two independent grants (PAR-9131 Q13); an agent write passes if either allows it:
 * - whole-site: `{ siteId, until, by }` (no `scope`) sets `approved_until`, exactly as before;
 * - page-scoped: `{ siteId, scope: "pages", pages, until, seq, by }` replaces the page set as a whole, only when
 *   `seq` is newer than the stored one. `pages: []` or a past `until` closes it. It allows only the narrow
 *   writes in `pageGrantRefusal` (Q14).
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { normalisePageUrl } from "@partnersinbiz/pib-plugin-kit";
import { table } from "./db.js";

export const SIGNOFF_EVENT = "site.signoff";
export const APPROVAL_EVENT = "site.write-approved";

/** The only endpoints a page grant can allow, each one targeting a single page by `url`. */
export const PAGE_GRANT_ENDPOINTS = ["posts/update", "posts/img-alt", "seo/set", "schema/set"] as const;
/** Keys the Connector resolves before `url` (class-pib-target.php, class-pib-schema.php): any of them defeats the page check. */
const OVERRIDING_KEYS = ["postId", "termId", "taxonomy", "postTypeArchive", "site"] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export async function onSignoffEvent(ctx: PluginContext, event: Pick<PluginEvent, "companyId" | "payload">): Promise<void> {
  const p = record(event.payload);
  if (!event.companyId || typeof p.siteId !== "string" || typeof p.required !== "boolean") return;
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "site_signoff")} (site_id, company_id, required) VALUES ($1, $2, $3)
     ON CONFLICT (site_id) DO UPDATE SET required = EXCLUDED.required, company_id = EXCLUDED.company_id, updated_at = now()`,
    [p.siteId, event.companyId, p.required],
  );
}

/** A positive integer seq as a decimal string (it is microseconds, past 2^31), or null. */
function seqOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,17}$/.test(value)) return value;
  return null;
}

export async function onApprovalEvent(ctx: PluginContext, event: Pick<PluginEvent, "companyId" | "payload">): Promise<void> {
  const p = record(event.payload);
  if (!event.companyId || typeof p.siteId !== "string") return;
  const until = typeof p.until === "string" && !Number.isNaN(Date.parse(p.until)) ? p.until : null;
  const by = typeof p.by === "string" ? p.by : null;
  if (p.scope === undefined) {
    if (!until) return;
    await ctx.db.execute(
      `INSERT INTO ${table(ctx, "site_signoff")} (site_id, company_id, required, approved_until, approved_by) VALUES ($1, $2, true, $3::timestamptz, $4)
       ON CONFLICT (site_id) DO UPDATE SET approved_until = EXCLUDED.approved_until, approved_by = EXCLUDED.approved_by, updated_at = now()`,
      [p.siteId, event.companyId, until, by],
    );
    return;
  }
  // An unknown scope is never read as whole-site: that would widen the grant.
  if (p.scope !== "pages" || !Array.isArray(p.pages)) return;
  const seq = seqOf(p.seq);
  if (!seq) return;
  // A close (`pages: []`) carries no until when the sender's page set is empty (max over nothing is null): it still
  // closes, with pages_until NULL. An open set needs a valid until.
  if (p.pages.length > 0 && !until) return;
  const pagesUntil = p.pages.length > 0 ? until : null;
  const pages = [...new Set(p.pages.map((page) => (typeof page === "string" ? normalisePageUrl(page) : null)).filter((page): page is string => page !== null))];
  // One guarded upsert: a late or out-of-order event (seq not newer) changes nothing. pages_opened_at marks when the
  // grant went from closed to open, so the change replay (T2b) knows where to start.
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "site_signoff")} AS s (site_id, company_id, required, pages, pages_until, pages_seq, pages_by, pages_opened_at)
     VALUES ($1, $2, true, $3::jsonb, $4::timestamptz, $5::bigint, $6, CASE WHEN jsonb_array_length($3::jsonb) > 0 AND $4::timestamptz > now() THEN now() END)
     ON CONFLICT (site_id) DO UPDATE SET pages = EXCLUDED.pages, pages_until = EXCLUDED.pages_until, pages_seq = EXCLUDED.pages_seq, pages_by = EXCLUDED.pages_by,
       pages_opened_at = CASE
         WHEN jsonb_array_length(EXCLUDED.pages) = 0 OR EXCLUDED.pages_until <= now() THEN s.pages_opened_at
         WHEN s.pages_until > now() AND jsonb_array_length(COALESCE(s.pages, '[]'::jsonb)) > 0 THEN COALESCE(s.pages_opened_at, now())
         ELSE now() END,
       updated_at = now()
     WHERE s.pages_seq < EXCLUDED.pages_seq`,
    [p.siteId, event.companyId, JSON.stringify(pages), pagesUntil, seq, by],
  );
}

export interface SignoffSite {
  id: string;
  url: string;
}

/** A site_changes row an `undo` would revert. */
export interface UndoTarget {
  endpoint: string;
  target: string | null;
}

/**
 * Why the open page grant does not allow this write, or null when it does (PAR-9131 Q14). Pure, so every bypass is
 * tested directly. `undoTarget` is the site's own ok change row for an `undo`'s changeId (null when there is none).
 */
export function pageGrantRefusal(site: SignoffSite, endpoint: string, params: Record<string, unknown>, pages: ReadonlySet<string>, undoTarget: UndoTarget | null = null): string | null {
  if (endpoint === "undo") {
    if (!undoTarget) return "the change to undo is not an applied change on this site";
    if (!(PAGE_GRANT_ENDPOINTS as readonly string[]).includes(undoTarget.endpoint)) return `the change to undo is a ${undoTarget.endpoint} change, which an approval for pages does not cover`;
    const page = undoTarget.target ? normalisePageUrl(undoTarget.target, site.url) : null;
    if (!page || !pages.has(page)) return "the change to undo is not on an approved page";
    return null;
  }
  if (!(PAGE_GRANT_ENDPOINTS as readonly string[]).includes(endpoint)) return `${endpoint} is not one of the page changes an approval for pages allows (${PAGE_GRANT_ENDPOINTS.join(", ")})`;
  if (typeof params.url !== "string" || !params.url.trim()) return "the change must name its page with url";
  const overriding = OVERRIDING_KEYS.filter((key) => params[key] !== undefined && params[key] !== null);
  if (overriding.length) return `leave out ${overriding.join(", ")}: the site would use ${overriding.length === 1 ? "it" : "them"} instead of url, so only url may name the page`;
  if (params.url.includes("?") || params.url.includes("#")) return "url must have no query (?) or fragment (#)";
  const page = normalisePageUrl(params.url, site.url);
  const siteUrl = normalisePageUrl(site.url);
  if (!page || !siteUrl) return "url is not a page address";
  if (new URL(page).host !== new URL(siteUrl).host) return `url is not on ${new URL(siteUrl).host}`;
  if (!pages.has(page)) return `${page} is not one of the approved pages`;
  return null;
}

function pagesOf(value: unknown): Set<string> {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      list = [];
    }
  }
  return new Set(Array.isArray(list) ? list.filter((page): page is string => typeof page === "string") : []);
}

/** Why an agent may not make this Connector write right now, or null. */
export async function signoffBlock(ctx: PluginContext, site: SignoffSite, endpoint: string, params: Record<string, unknown>): Promise<string | null> {
  const rows = await ctx.db.query(
    `SELECT required, (approved_until IS NOT NULL AND approved_until > now()) AS approved,
            (pages_until IS NOT NULL AND pages_until > now()) AS pages_open, pages
       FROM ${table(ctx, "site_signoff")} WHERE site_id = $1 LIMIT 1`,
    [site.id],
  );
  const row = rows[0];
  if (!row || !row.required || row.approved) return null;
  const pages = row.pages_open ? pagesOf(row.pages) : new Set<string>();
  if (pages.size > 0) {
    let undoTarget: UndoTarget | null = null;
    if (endpoint === "undo" && typeof params.changeId === "string" && params.changeId) {
      const changes = await ctx.db.query(
        `SELECT endpoint, target FROM ${table(ctx, "site_changes")} WHERE site_id = $1 AND change_ref = $2 AND ok = true ORDER BY created_at DESC LIMIT 1`,
        [site.id, params.changeId],
      );
      const change = changes[0];
      if (change && typeof change.endpoint === "string") undoTarget = { endpoint: change.endpoint, target: typeof change.target === "string" ? change.target : null };
    }
    const refusal = pageGrantRefusal(site, endpoint, params, pages, undoTarget);
    if (!refusal) return null;
    return `This site needs the client's sign-off before anything changes (change policy pr_only). Only the approved pages may change now (${[...pages].join(", ")}), and this write is refused: ${refusal}. Do not retry it in another form. To open or widen a window: the client approves a preview (partnersinbiz.seo:create-preview), a person clicks \"Apply approved changes\" (approve-site-writes), or a sign-off delegate calls partnersinbiz.seo:approve-page-apply (sprintId, taskId, pageUrls, with a Reviewer PASS). Change only the approved pages with posts/update, posts/img-alt, seo/set or schema/set by url alone; anything else needs a new preview and approval.`;
  }
  return "This site needs the client's sign-off before anything changes (change policy pr_only), and no approval to apply is running. Do not write to it. A window opens three ways: the client approves a preview (partnersinbiz.seo:create-preview), a person clicks \"Apply approved changes\" (approve-site-writes), or a sign-off delegate calls partnersinbiz.seo:approve-page-apply (sprintId, taskId, pageUrls, with a Reviewer PASS). Make a client preview with create-preview (partnersinbiz.seo), put the proposal and link on Needs you and block-task. When a window is open this tool works again for it.";
}
