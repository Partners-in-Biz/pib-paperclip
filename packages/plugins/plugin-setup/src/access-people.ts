/**
 * What the People tab reads in one call (PAR-12578 plan, 4.8, 4.3 and 4.4).
 * Owner or admin only. Names are not here: the page reads them from the core
 * members route in the browser, so the worker never holds them.
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { PERMISSION_CATALOG, PRESETS, listAccess, type AccessRow, type ActorInput, type SaveGrantInput } from "@partnersinbiz/pib-plugin-kit";
import { getAccessLost, getAccessSettings, listAccessRefusals, type AccessRefusal } from "./access-store.js";
import { accessPluginStatus, type AccessPluginStatus } from "./access-sync.js";
import { NAMESPACE } from "./namespace.js";

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
  /** Per limited person, the CRM companies he owns or manages (stage B-D9), from Setup's copy of the CRM. Name order. */
  managed: Record<string, ManagedCompany[]>;
};

export interface ManagedCompany {
  id: string;
  name: string;
}

/** At most this many companies are named per person; the CRM lists the rest. */
export const MANAGED_SHOWN = 50;

/**
 * The CRM companies each of these people owns or manages, from Setup's copy (kit `registerCrmProjection`
 * with `companyManagers`). A copy without managers yet (a CRM event not seen since stage B) names nothing.
 */
export async function managedCompanies(ctx: PluginContext, companyId: string, userIds: string[]): Promise<Record<string, ManagedCompany[]>> {
  const out: Record<string, ManagedCompany[]> = Object.fromEntries(userIds.map((id) => [id, []]));
  if (!userIds.length) return out;
  const rows = await ctx.db.query<{ id: string; name: string; managers: { ownerUserId?: unknown; managerUserIds?: unknown } | null }>(
    `SELECT id, name, managers FROM ${NAMESPACE}.crm_companies WHERE company_id = $1 AND deleted = false AND managers IS NOT NULL ORDER BY lower(name), id`,
    [companyId],
  );
  for (const row of rows) {
    const ids = new Set([row.managers?.ownerUserId, ...(Array.isArray(row.managers?.managerUserIds) ? row.managers!.managerUserIds : [])].filter((id): id is string => typeof id === "string"));
    for (const id of ids) {
      const list = out[id];
      if (list && list.length < MANAGED_SHOWN) list.push({ id: row.id, name: row.name });
    }
  }
  return out;
}

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
 * whole grant from it, so the scope overrides must come through; the kit checks
 * the values. Linked companies are not taken (stage B-D9): a person's own
 * companies are the ones the CRM says he manages, so Setup no longer writes a list.
 */
export function saveGrantParams(params: Record<string, unknown>): SaveGrantInput {
  return {
    userId: typeof params.userId === "string" ? params.userId : "",
    preset: params.preset as SaveGrantInput["preset"],
    allow: params.allow as string[] | undefined,
    deny: params.deny as string[] | undefined,
    scopeOverrides: params.scopeOverrides as SaveGrantInput["scopeOverrides"],
  };
}

export async function accessPeople(ctx: PluginContext, companyId: string, actor: ActorInput): Promise<AccessPeopleView | { ok: false; error: string }> {
  // `listAccess` refuses anyone who is not an owner or admin before it reads a member.
  const list = await listAccess(ctx, { companyId, actor });
  if (!list.ok) return list;
  const settings = await getAccessSettings(ctx, companyId);
  const lost = settings ? null : await getAccessLost(ctx, companyId);
  const people = list.rows.filter((row) => row.role !== "owner" && row.role !== "admin");
  return {
    ok: true,
    mode: settings?.mode ?? "off",
    rev: settings?.rev ?? 0,
    plugins: await accessPluginStatus(ctx, settings, companyId),
    switchLost: lost !== null,
    people,
    refusals: await listAccessRefusals(ctx, companyId, PEOPLE_REFUSALS_SHOWN),
    areas: accessAreas(),
    presets: Object.values(PRESETS).map((preset) => ({ id: preset.id, label: preset.label })),
    managed: await managedCompanies(ctx, companyId, people.map((row) => row.userId)),
  };
}
