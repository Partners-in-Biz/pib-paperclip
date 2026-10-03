/**
 * Sign-off lock: a WordPress site whose SEO sprint has change policy pr_only is changed only after a person
 * says so. The SEO plugin sends `site.signoff` ({ siteId, required }) whenever it checks the policy and
 * `site.write-approved` ({ siteId, until, by }) when a person approves applying the signed-off changes.
 * Agents' Connector writes are refused while the lock is on and no approval is running; people are never blocked.
 */
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { table } from "./db.js";

export const SIGNOFF_EVENT = "site.signoff";
export const APPROVAL_EVENT = "site.write-approved";

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

export async function onApprovalEvent(ctx: PluginContext, event: Pick<PluginEvent, "companyId" | "payload">): Promise<void> {
  const p = record(event.payload);
  if (!event.companyId || typeof p.siteId !== "string" || typeof p.until !== "string" || Number.isNaN(Date.parse(p.until))) return;
  await ctx.db.execute(
    `INSERT INTO ${table(ctx, "site_signoff")} (site_id, company_id, required, approved_until, approved_by) VALUES ($1, $2, true, $3::timestamptz, $4)
     ON CONFLICT (site_id) DO UPDATE SET approved_until = EXCLUDED.approved_until, approved_by = EXCLUDED.approved_by, updated_at = now()`,
    [p.siteId, event.companyId, p.until, typeof p.by === "string" ? p.by : null],
  );
}

/** Why an agent may not change this site right now, or null. */
export async function signoffBlock(ctx: PluginContext, siteId: string): Promise<string | null> {
  const rows = await ctx.db.query(
    `SELECT required, (approved_until IS NOT NULL AND approved_until > now()) AS approved FROM ${table(ctx, "site_signoff")} WHERE site_id = $1 LIMIT 1`,
    [siteId],
  );
  const row = rows[0];
  if (!row || !row.required || row.approved) return null;
  return "This site needs the client's sign-off before anything changes (change policy pr_only), and no approval to apply is running. Do not write to it. Make a client preview with create-preview (partnersinbiz.seo), put the proposal and link on Needs you and block-task. When the owner has approved applying the changes this tool works again for the approved window.";
}
