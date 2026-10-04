import { createHash } from "node:crypto";

export const PLUGIN_ID = "partnersinbiz.campaigns";
export const PLUGIN_VERSION = "0.7.0";
export const NAMESPACE_SLUG = "campaigns";
/** The managed project this plugin declares for PiB's own campaign work. */
export const CAMPAIGNS_PROJECT_KEY = "campaigns";

/** Same derivation the Paperclip host uses for a plugin schema. */
export function pluginNamespace(pluginId = PLUGIN_ID, slug = NAMESPACE_SLUG): string {
  const hash = createHash("sha256").update(pluginId).digest("hex").slice(0, 10);
  const safeSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 36) || "plugin";
  return `plugin_${safeSlug}_${hash}`.slice(0, 63);
}

export const NAMESPACE = pluginNamespace();
