/**
 * Module switch (Setup plugin) and the companies this plugin knows about.
 *
 * Jobs have no company scope, so every loop asks `adsOn` before doing any work for a company. No choice saved = on.
 * Company ids come from the plugin's own rows and its own memory, never from `ctx.companies.list` (the host refuses it while another call is in flight).
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isModuleEnabled, knownCompanyIds } from "@partnersinbiz/pib-plugin-kit";
import { companiesWithAccounts, companiesWithConnections } from "./db.js";
import { loadAdsConfig } from "./config.js";
import { PLUGIN_ID } from "./platforms.js";

export const MODULE_OFF_MESSAGE = "Paid ads is switched off for this company. Turn it on in Setup.";

/** False only when the company switched the Ads module off in Setup. */
export function adsOn(ctx: PluginContext, companyId: string): Promise<boolean> {
  return isModuleEnabled(ctx, companyId, PLUGIN_ID);
}

/** Companies the plugin has served (the kit remembers every company a call came from) plus company ids from our own rows. */
export async function knownCompanies(ctx: PluginContext): Promise<string[]> {
  const ids = new Set<string>(await knownCompanyIds(ctx));
  for (const id of await companiesWithAccounts(ctx).catch(() => [] as string[])) ids.add(id);
  for (const id of await companiesWithConnections(ctx).catch(() => [] as string[])) ids.add(id);
  return [...ids];
}

/**
 * True for a company that can use Ads: the module is not switched off and its settings were saved. The jobs act only for these (the host refuses
 * company calls for a company with no saved settings, which would only fill the job's problem count).
 */
export async function companyUsesAds(ctx: PluginContext, companyId: string): Promise<boolean> {
  return (await adsOn(ctx, companyId)) && (await loadAdsConfig(ctx, companyId)).saved;
}
