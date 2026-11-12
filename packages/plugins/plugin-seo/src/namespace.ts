import { createHash } from "node:crypto";

export const PLUGIN_ID = "partnersinbiz.seo";
export const NAMESPACE_SLUG = "seo";
/** The plugin's version (the manifest and package.json carry the same). */
<<<<<<< HEAD
export const PLUGIN_VERSION = "0.47.1";
||||||| parent of a4e653bc3 (fix(plugin-seo): bump to 0.48.0 after T6 took 0.47.0, reindent PreviewActions (PAR-9146))
export const PLUGIN_VERSION = "0.47.0";
=======
export const PLUGIN_VERSION = "0.48.0";
>>>>>>> a4e653bc3 (fix(plugin-seo): bump to 0.48.0 after T6 took 0.47.0, reindent PreviewActions (PAR-9146))

export function pluginNamespace(pluginId = PLUGIN_ID, slug = NAMESPACE_SLUG): string {
  const hash = createHash("sha256").update(pluginId).digest("hex").slice(0, 10);
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36) || "plugin";
  return `plugin_${safeSlug}_${hash}`.slice(0, 63);
}

export const NAMESPACE = pluginNamespace();
