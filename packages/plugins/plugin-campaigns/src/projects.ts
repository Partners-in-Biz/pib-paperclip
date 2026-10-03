/**
 * Which Paperclip project a campaign's issues open in (Q1a-12).
 *
 * A client's campaign belongs in the client's own project (the one the CRM
 * linked to the client), never mixed into PiB's own work. Own work, and a client
 * with no linked project, open in the managed Campaigns project this plugin
 * declares. The kit does the choosing (`resolveClientProjectId`): the link
 * arrives as the CRM's `client.projects.updated` event.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { resolveClientProjectId } from "@partnersinbiz/pib-plugin-kit";
import { campaignScope, type CampaignDraft } from "./domain.js";
import { CAMPAIGNS_PROJECT_KEY } from "./namespace.js";

export { CAMPAIGNS_PROJECT_KEY };

const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; id: string | null }>();

export function clearProjectCache(): void {
  cache.clear();
}

/** The managed Campaigns project of a company, created on first use. Null when the host cannot give one. */
export async function campaignsProjectId(ctx: PluginContext, companyId: string): Promise<string | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.id;
  let id: string | null = null;
  try {
    id = (await ctx.projects.managed.get(CAMPAIGNS_PROJECT_KEY, companyId)).projectId ?? null;
    if (!id) id = (await ctx.projects.managed.reconcile(CAMPAIGNS_PROJECT_KEY, companyId)).projectId ?? null;
  } catch (error) {
    ctx.logger.info("The Campaigns project could not be resolved; issues open without a project", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
  // A miss is remembered for a shorter time so a project created meanwhile is found soon.
  cache.set(companyId, { at: id ? Date.now() : Date.now() - CACHE_MS + 60_000, id });
  return id;
}

/** The project to open a campaign's issue in, or undefined for none. */
export async function projectForCampaign(ctx: PluginContext, companyId: string, campaign: Pick<CampaignDraft, "clientKind" | "clientRef"> | null): Promise<string | undefined> {
  const fallbackProjectId = await campaignsProjectId(ctx, companyId);
  const choice = await resolveClientProjectId(ctx, companyId, campaign ? campaignScope(campaign) : null, { fallbackProjectId });
  return choice.projectId ?? undefined;
}
