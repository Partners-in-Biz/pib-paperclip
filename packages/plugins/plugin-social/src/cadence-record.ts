/** The cadence actions and tool: read a scope's cadence with its gaps; a person saves or clears it. */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { cadenceGaps, cadenceSummary, getCadence, normalizeCadence, setCadence, type Cadence } from "./cadence.js";
import { scopeOfRow, type ClientScope } from "./clients.js";
import { loadSocialConfig } from "./config.js";
import { iso, table } from "./db.js";
import { PLATFORM_LABELS, type SocialPlatform } from "./platforms.js";
import { readScope, requireUser, type Viewer } from "./service.js";

function sameScope(row: { client_kind: string | null; client_ref: string | null }, scope: ClientScope): boolean {
  const other = scopeOfRow(row);
  if (!scope || !other) return !scope && !other;
  return other.kind === scope.kind && other.id.toLowerCase() === scope.id.toLowerCase();
}

/** The scope's cadence, a one-line summary and the free slots for its days ahead. `cadence: null` when none is set. */
export async function cadenceView(ctx: PluginContext, companyId: string, scope: ClientScope, cadence: Cadence | null, now: Date = new Date()) {
  if (!cadence) return { cadence: null, summary: "No cadence set: the Social agent decides how many posts to make.", days: [] };
  const timeZone = (await loadSocialConfig(ctx, companyId)).timezone || "UTC";
  const [accounts, posts] = await Promise.all([
    ctx.db.query<{ id: string; platform: string; display_name: string; client_kind: string | null; client_ref: string | null }>(
      `SELECT id, platform, display_name, client_kind, client_ref FROM ${table(ctx, "accounts")} WHERE company_id = $1 AND scope = 'org' AND status <> 'disabled'`,
      [companyId],
    ),
    ctx.db.query<{ status: string; scheduled_at: unknown; published_at: unknown; client_kind: string | null; client_ref: string | null; accounts: string | null }>(
      `SELECT p.status, p.scheduled_at, p.published_at, p.client_kind, p.client_ref,
              (SELECT string_agg(d.account_id, ',') FROM ${table(ctx, "destinations")} d WHERE d.post_id = p.id) AS accounts
         FROM ${table(ctx, "posts")} p
        WHERE p.company_id = $1 AND p.archived_at IS NULL AND p.scope = 'org'
          AND coalesce(p.published_at, p.scheduled_at) BETWEEN now() - interval '1 day' AND now() + interval '9 days'
          AND p.status IN ('draft', 'review', 'approved', 'scheduled', 'publishing', 'published', 'partially_published')`,
      [companyId],
    ),
  ]);
  const mine = accounts.filter((a) => sameScope(a, scope));
  const names = new Map(mine.map((a) => [a.id, `${PLATFORM_LABELS[a.platform as SocialPlatform] ?? a.platform} (${a.display_name})`]));
  const rows = posts
    .filter((p) => sameScope(p, scope))
    .map((p) => ({ at: (["published", "partially_published"].includes(p.status) ? iso(p.published_at) : null) ?? iso(p.scheduled_at), accounts: p.accounts ? p.accounts.split(",") : [] }))
    .filter((p): p is { at: string; accounts: string[] } => Boolean(p.at));
  const days = cadenceGaps(cadence, mine.map((a) => ({ id: a.id, platform: a.platform, name: names.get(a.id)! })), rows, now, timeZone);
  return {
    cadence,
    summary: cadenceSummary(cadence),
    timeZone,
    days: days.map((d) => ({ ...d, free: d.free.map((f) => ({ ...f, accounts: f.accountIds.map((id) => names.get(id) ?? id) })) })),
  };
}

/** `get-cadence` and `social.get-cadence`: anyone who can see the scope. */
export async function getCadenceRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const target = await readScope(ctx, viewer, params);
  return cadenceView(ctx, viewer.companyId, target.scope, await getCadence(ctx, viewer.companyId, target.scope));
}

/** `social.set-cadence`: a person saves the scope's cadence, or clears it with `clear: true`. */
export async function setCadenceRecord(ctx: PluginContext, viewer: Viewer, params: Record<string, unknown>) {
  const userId = requireUser(viewer, "set a posting cadence");
  const target = await readScope(ctx, viewer, params);
  if (params.clear === true) {
    await setCadence(ctx, viewer.companyId, target.scope, null);
    ctx.logger.info("Social cadence cleared", { companyId: viewer.companyId, by: userId });
    return cadenceView(ctx, viewer.companyId, target.scope, null);
  }
  const cadence = normalizeCadence(params, userId);
  await setCadence(ctx, viewer.companyId, target.scope, cadence);
  ctx.logger.info("Social cadence set", { companyId: viewer.companyId, by: userId, summary: cadenceSummary(cadence) });
  return cadenceView(ctx, viewer.companyId, target.scope, cadence);
}
