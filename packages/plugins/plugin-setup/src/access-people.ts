/**
 * What the People tab reads in one call (PAR-12578 plan, 4.8, 4.3 and 4.4).
 * Owner or admin only. Names are not here: the page reads them from the core
 * members route in the browser, so the worker never holds them.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { PERMISSION_CATALOG, PRESETS, listAccess, type AccessRow, type ActorInput, type SaveGrantInput } from "@partnersinbiz/pib-plugin-kit";
import { getAccessLost, getAccessSettings, listAccessRefusals, type AccessRefusal } from "./access-store.js";
import { accessPluginStatus, type AccessPluginStatus } from "./access-sync.js";

/** Refusals shown on the report list, newest first. */
export const PEOPLE_REFUSALS_SHOWN = 100;

export interface AccessArea {
  area: string;
  keys: string[];
}

export type AccessPeopleView = {
  ok: true;
  mode: "off" | "report" | "enforce";
  rev: number;
  plugins: AccessPluginStatus[];
  /** True when Setup has no settings row but a plugin reported a `rev`: the owner chooses the switch again. */
  switchLost: boolean;
  people: AccessRow[];
  refusals: AccessRefusal[];
  areas: AccessArea[];
  presets: Array<{ id: string; label: string }>;
};

/** The catalog grouped by area, in catalog order. */
export function accessAreas(): AccessArea[] {
  const areas = new Map<string, string[]>();
  for (const resource of PERMISSION_CATALOG) {
    const keys = areas.get(resource.area) ?? [];
    keys.push(...resource.actions.map((action) => `${resource.id}:${action}`));
    areas.set(resource.area, keys);
  }
  return [...areas].map(([area, keys]) => ({ area, keys }));
}

/**
 * The `setup.access.save-grant` params as the kit's input. The kit rebuilds the
 * whole grant from it, so every stored field (scope overrides, linked companies)
 * must come through; the kit checks the values.
 */
export function saveGrantParams(params: Record<string, unknown>): SaveGrantInput {
  return {
    userId: typeof params.userId === "string" ? params.userId : "",
    preset: params.preset as SaveGrantInput["preset"],
    allow: params.allow as string[] | undefined,
    deny: params.deny as string[] | undefined,
    linkedCompanyIds: params.linkedCompanyIds as string[] | undefined,
    scopeOverrides: params.scopeOverrides as SaveGrantInput["scopeOverrides"],
  };
}

export async function accessPeople(ctx: PluginContext, companyId: string, actor: ActorInput): Promise<AccessPeopleView | { ok: false; error: string }> {
  // `listAccess` refuses anyone who is not an owner or admin before it reads a member.
  const list = await listAccess(ctx, { companyId, actor });
  if (!list.ok) return list;
  const settings = await getAccessSettings(ctx, companyId);
  const lost = settings ? null : await getAccessLost(ctx, companyId);
  return {
    ok: true,
    mode: settings?.mode ?? "off",
    rev: settings?.rev ?? 0,
    plugins: await accessPluginStatus(ctx, settings, companyId),
    switchLost: lost !== null,
    people: list.rows.filter((row) => row.role !== "owner" && row.role !== "admin"),
    refusals: await listAccessRefusals(ctx, companyId, PEOPLE_REFUSALS_SHOWN),
    areas: accessAreas(),
    presets: Object.values(PRESETS).map((preset) => ({ id: preset.id, label: preset.label })),
  };
}
