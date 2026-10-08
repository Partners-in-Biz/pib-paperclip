import { createHash } from "node:crypto";

export const PLUGIN_ID = "partnersinbiz.seo";
export const NAMESPACE_SLUG = "seo";
/** The plugin's version (the manifest and package.json carry the same). */
export const PLUGIN_VERSION = "0.26.19";

export function pluginNamespace(pluginId = PLUGIN_ID, slug = NAMESPACE_SLUG): string {
  const hash = createHash("sha256").update(pluginId).digest("hex").slice(0, 10);
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "plugin";
  return `plugin_${safeSlug}_${hash}`.slice(0, 63);
}

export const NAMESPACE = pluginNamespace();
