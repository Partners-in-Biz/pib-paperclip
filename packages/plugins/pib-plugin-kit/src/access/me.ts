/**
 * `access.me` (PAR-12578 plan, 4.6): what the caller may do in this plugin, for
 * the page gate (`useAccess` in the UI kit). The guard registers it.
 *
 * `{ mode, open, permissions }`. `permissions` are the catalog keys of the
 * plugin's areas the caller may use now. Under `off` and `report` nothing is
 * limited, so that is every key and `open` is true. Under `enforce` `open` is
 * false when he has none. The page gate only shapes the screen; the guard is
 * the gate.
 */
import { decideAccess, permissionKey, PERMISSION_CATALOG, type Access } from "../permissions.js";
import type { GuardedPluginKey } from "../guarded-plugins.js";
import type { AccessMode } from "./switch.js";

export const ACCESS_ME_ACTION = "access.me";

export interface AccessMe {
  mode: AccessMode;
  open: boolean;
  permissions: string[];
}

/** The catalog areas each guarded plugin owns. */
export const PLUGIN_AREAS: Readonly<Record<GuardedPluginKey, readonly string[]>> = Object.freeze({
  "partnersinbiz.crm": ["crm"],
  "partnersinbiz.social": ["social"],
  "partnersinbiz.seo": ["seo"],
  "partnersinbiz.ads": ["ads"],
  "partnersinbiz.campaigns": ["campaigns"],
  "partnersinbiz.billing": ["billing"],
  "partnersinbiz.mailbox": ["mailbox"],
  "partnersinbiz.partners": ["partners"],
  "partnersinbiz.accounting": ["accounting"],
  "partnersinbiz.payroll": ["payroll"],
  "partnersinbiz.setup": ["setup"],
  "partnersinbiz.cockpit": ["cockpit"],
  "partnersinbiz.studio": ["studio"],
  "partnersinbiz.crm-telephony": ["telephony"],
  "partnersinbiz.voice": ["voice"],
});

/** Areas of a plugin; none for a plugin outside the guarded list. */
export function areasOf(pluginKey: string): readonly string[] {
  return Object.hasOwn(PLUGIN_AREAS, pluginKey) ? PLUGIN_AREAS[pluginKey as GuardedPluginKey] : [];
}

/** Every catalog key of these areas. */
export function areaKeys(areas: readonly string[]): string[] {
  return PERMISSION_CATALOG.filter((r) => areas.includes(r.area)).flatMap((r) => r.actions.map((a) => permissionKey(r.id, a)));
}

/** The keys of these areas a verified person may use (an own-companies scope counts as a permission). */
export function allowedKeys(access: Access, areas: readonly string[]): string[] {
  return PERMISSION_CATALOG.filter((r) => areas.includes(r.area)).flatMap((r) =>
    r.actions.filter((a) => decideAccess(access, r.id, a).allowed).map((a) => permissionKey(r.id, a)),
  );
}
