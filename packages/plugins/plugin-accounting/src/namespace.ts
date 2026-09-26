import { createHash } from "node:crypto";

export const PLUGIN_ID = "partnersinbiz.accounting";
export const NAMESPACE_SLUG = "accounting";

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

/** `plugin_accounting_03d0185a67` */
export const NAMESPACE = pluginNamespace();
