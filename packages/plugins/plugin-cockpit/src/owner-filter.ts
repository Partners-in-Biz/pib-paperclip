/**
 * The issues that never belong on the owner's list (PAR-10548 T2): container
 * issues (a SEO sprint's root), the standing queue (a Cockpit setting) and the
 * canary test client's work. The set feeds `splitOwnerWaiting` and the
 * unassigned count, so every surface agrees.
 */
import { readConfig } from "@partnersinbiz/pib-plugin-kit";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Env } from "./env.js";
import { message } from "./env.js";
import { canaryProjectIds } from "./clients.js";

/** Issues with these origins are containers: they hold work and are never the owner's to decide. */
export const CONTAINER_ORIGIN_KINDS = ["plugin:partnersinbiz.seo:sprint"];

const STANDING_QUEUE_ID = /^[A-Z][A-Z0-9]*-\d+$/;
const HIDDEN_LIMIT = 1000;

export interface OwnerFilterResult {
  hiddenIssueIds: string[];
  /** Parts whose read failed (`canary`, `standingQueue`, or `limit` when the row cap cut the list); that part is empty. */
  degraded: string[];
}

/** The `standingQueueIssues` setting: valid issue identifiers only. */
export async function standingQueueIssues(ctx: PluginContext, companyId: string): Promise<string[]> {
  const config = await readConfig(ctx, companyId);
  const raw = config.standingQueueIssues;
  return Array.isArray(raw) ? [...new Set(raw.filter((v): v is string => typeof v === "string" && STANDING_QUEUE_ID.test(v.trim())).map((v) => v.trim()))] : [];
}

/** One query: the open issues that are containers, in the standing queue or in a canary project. A failed canary or config read leaves that part empty. */
export async function ownerFilter(env: Env, companyId: string): Promise<OwnerFilterResult> {
  const degraded: string[] = [];
  const part = async (name: string, read: () => Promise<string[]>): Promise<string[]> => {
    try {
      return await read();
    } catch (error) {
      degraded.push(name);
      env.ctx.logger.info("Cockpit owner filter part failed", { companyId, part: name, error: message(error) });
      return [];
    }
  };
  const [identifiers, projects] = await Promise.all([part("standingQueue", () => standingQueueIssues(env.ctx, companyId)), part("canary", () => canaryProjectIds(env.ctx, companyId))]);
  const rows = await env.ctx.db.query<{ id: string }>(
    `SELECT id FROM public.issues WHERE company_id = $1 AND hidden_at IS NULL AND status IN ('todo', 'in_progress', 'in_review', 'blocked')
       AND (origin_kind = ANY(ARRAY(SELECT jsonb_array_elements_text($2::jsonb))::text[]) OR identifier = ANY(ARRAY(SELECT jsonb_array_elements_text($3::jsonb))::text[])
         OR project_id = ANY(ARRAY(SELECT jsonb_array_elements_text($4::jsonb))::uuid[])) LIMIT ${HIDDEN_LIMIT}`,
    [companyId, JSON.stringify(CONTAINER_ORIGIN_KINDS), JSON.stringify(identifiers), JSON.stringify(projects)],
  );
  if (rows.length >= HIDDEN_LIMIT) {
    degraded.push("limit");
    env.ctx.logger.info("Cockpit owner filter hit its row cap", { companyId, limit: HIDDEN_LIMIT });
  }
  return { hiddenIssueIds: rows.map((r) => String(r.id)), degraded };
}
