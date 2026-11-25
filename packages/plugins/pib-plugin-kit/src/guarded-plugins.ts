/**
 * The plugins that carry the per-person access guard (PAR-12578 plan, section 4.3).
 *
 * Fixed on purpose: Setup refuses the `enforce` switch unless every plugin in this
 * list has confirmed the company's current access revision. The list must never be
 * built from what plugins report, because a plugin whose receiver is broken never
 * reports, and that is the plugin the rule has to catch.
 *
 * `PIB_PLUGINS` (the event contract list) stays as it is; this adds Studio, CRM
 * telephony and Voice, which are not part of the event contracts.
 */
import { PIB_PLUGINS } from "./contracts.js";

export const GUARDED_PLUGINS = Object.freeze([
  ...Object.values(PIB_PLUGINS),
  "partnersinbiz.studio",
  "partnersinbiz.crm-telephony",
  "partnersinbiz.voice",
] as const);

export type GuardedPluginKey = (typeof GUARDED_PLUGINS)[number];

export function isGuardedPlugin(key: unknown): key is GuardedPluginKey {
  return typeof key === "string" && (GUARDED_PLUGINS as readonly string[]).includes(key);
}
