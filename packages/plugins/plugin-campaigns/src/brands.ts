/**
 * Our own brands: CRM companies that are ours, not clients (Velox, JagGids and the like). Their campaigns live in the
 * company's own workspace with their own sender and do-not-email list, like a client's, but they are approved like our
 * own campaigns: no "client's written yes".
 *
 * The list is the `ownBrands` preference (company names, one per line), which only a company owner or admin can change,
 * never an agent. A name that matches no CRM company marks nothing, so a renamed company falls back to the client rules.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { table } from "./db.js";
import type { CampaignDraft } from "./domain.js";
import { readCampaignPreferences } from "./preferences.js";

export interface OwnBrand { id: string; name: string }

/** Names from the preference text: one per line or comma separated, trimmed, lower-cased, without blanks or repeats. */
export function brandNames(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return [...new Set(text.split(/[\n,]/).map((name) => name.trim().toLowerCase()).filter(Boolean))];
}

/** The CRM companies of this company that the owner marked as our own brands. Empty when none are marked. */
export async function ownBrands(ctx: PluginContext, companyId: string): Promise<OwnBrand[]> {
  const preferences = await readCampaignPreferences(ctx, companyId);
  const names = new Set(brandNames(preferences.ownBrands));
  if (names.size === 0) return [];
  const rows = await ctx.db.query<{ id: string; name: string }>(
    `SELECT id, name FROM ${table(ctx, "crm_companies")} WHERE company_id = $1 AND deleted = false ORDER BY name, id LIMIT 2000`,
    [companyId],
  );
  return rows.filter((row) => names.has(row.name.trim().toLowerCase())).map((row) => ({ id: row.id, name: row.name }));
}

/** True for a campaign of a CRM company that is one of our own brands. A contact client is never a brand. */
export function isOwnBrandCampaign(brands: OwnBrand[], campaign: Pick<CampaignDraft, "clientKind" | "clientRef">): boolean {
  return Boolean(campaign.clientRef) && (campaign.clientKind ?? "company") === "company" && brands.some((brand) => brand.id === campaign.clientRef);
}

/**
 * Whether the client rules apply to this campaign: it is for a client, and that client is not one of our own brands.
 * When the brand list cannot be read the answer is yes (the stricter rules).
 */
export async function isClientCampaign(ctx: PluginContext, companyId: string, campaign: Pick<CampaignDraft, "clientKind" | "clientRef">): Promise<boolean> {
  if (!campaign.clientRef) return false;
  const brands = await ownBrands(ctx, companyId).catch(() => [] as OwnBrand[]);
  return !isOwnBrandCampaign(brands, campaign);
}
