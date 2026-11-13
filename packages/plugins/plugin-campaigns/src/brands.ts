/**
 * Our own brands: CRM companies that are ours, not clients (Velox, JagGids and the like). Their campaigns live in the
 * company's own workspace with their own sender and do-not-email list, like a client's, but they are approved like our
 * own campaigns: no "client's written yes".
 *
 * The list is the `ownBrands` preference, which only a company owner or admin can change, never an agent. Each line is
 * a CRM company id followed by its name. Only the id counts: the name is there for the person reading the list. A
 * company is matched by id because names are free text, not unique, and an agent can create a CRM company with any
 * name. A line whose id matches no live CRM company of this company marks nothing.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { table } from "./db.js";
import type { CampaignDraft } from "./domain.js";
import { readCampaignPreferences } from "./preferences.js";

export interface OwnBrand { id: string; name: string }

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The CRM company ids on the list: the first word of each line. A line that does not start with an id is ignored. */
export function brandIds(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const ids = text.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0] ?? "").filter((id) => ID.test(id));
  return [...new Set(ids)];
}

/** The list as text with one company added or taken away: `<id> <name>` per line, other lines kept as they are. */
export function withBrand(text: unknown, brand: OwnBrand, own: boolean): string {
  const lines = (typeof text === "string" ? text : "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const others = lines.filter((line) => line.split(/\s+/)[0] !== brand.id);
  return (own ? [...others, `${brand.id} ${brand.name.replace(/\s+/g, " ").trim()}`] : others).join("\n");
}

/** The CRM companies of this company that the owner marked as our own brands. Empty when none are marked. */
export async function ownBrands(ctx: PluginContext, companyId: string): Promise<OwnBrand[]> {
  const preferences = await readCampaignPreferences(ctx, companyId);
  const ids = brandIds(preferences.ownBrands);
  const brands: OwnBrand[] = [];
  // One read per marked company (a list of ids cannot be bound as one parameter), at most 50.
  for (const id of ids.slice(0, 50)) {
    const rows = await ctx.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM ${table(ctx, "crm_companies")} WHERE company_id = $1 AND id = $2 AND deleted = false LIMIT 1`,
      [companyId, id],
    );
    if (rows[0]) brands.push({ id: rows[0].id, name: rows[0].name });
  }
  return brands.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
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
