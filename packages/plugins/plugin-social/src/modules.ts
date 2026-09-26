/**
 * Module switch (Setup plugin) and the companies this plugin knows about.
 *
 * Jobs have no company scope, so every loop asks `socialOn` before doing any
 * work for a company. No choice saved = on.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { isModuleEnabled } from "@partnersinbiz/pib-plugin-kit";
import { companiesWithAccounts, table } from "./db.js";
import { PLUGIN_ID } from "./platforms.js";

export const MODULE_OFF_MESSAGE = "Social is switched off for this company. Turn it on in Setup.";

/** False only when the company switched the Social module off in Setup. */
export function socialOn(ctx: PluginContext, companyId: string): Promise<boolean> {
  return isModuleEnabled(ctx, companyId, PLUGIN_ID);
}

/** Per-run cache for loops that see the same company many times (RSS feeds). */
export function moduleGate(ctx: PluginContext): (companyId: string) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>();
  return (companyId) => {
    let hit = seen.get(companyId);
    if (!hit) {
      hit = socialOn(ctx, companyId);
      seen.set(companyId, hit);
    }
    return hit;
  };
}

const KNOWN_STATE = { scopeKind: "instance" as const, namespace: "social-setup", stateKey: "companies" };
const remembered = new Set<string>();

/** Remember a company that used the plugin (page, tools, routes), so the hourly setup status reaches it before it has rows. */
export async function rememberCompany(ctx: PluginContext, companyId: string): Promise<void> {
  if (!companyId || remembered.has(companyId)) return;
  try {
    const current = await ctx.state.get(KNOWN_STATE);
    const list = Array.isArray(current) ? current.filter((id): id is string => typeof id === "string") : [];
    if (!list.includes(companyId)) await ctx.state.set(KNOWN_STATE, [...list, companyId].slice(-500));
    remembered.add(companyId);
  } catch (error) {
    ctx.logger.info("Social could not remember the company", { companyId, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Companies seen by the plugin plus company ids from our own rows. */
export async function knownCompanies(ctx: PluginContext): Promise<string[]> {
  const ids = new Set<string>();
  try {
    const current = await ctx.state.get(KNOWN_STATE);
    if (Array.isArray(current)) for (const id of current) if (typeof id === "string" && id) ids.add(id);
  } catch {
    // no list yet
  }
  for (const id of await companiesWithAccounts(ctx).catch(() => [] as string[])) ids.add(id);
  try {
    const rows = await ctx.db.query<{ company_id: string }>(`SELECT DISTINCT company_id FROM ${table(ctx, "posts")}`);
    for (const row of rows) if (row.company_id) ids.add(row.company_id);
  } catch {
    // posts table unreadable: the other sources still count
  }
  return [...ids];
}
