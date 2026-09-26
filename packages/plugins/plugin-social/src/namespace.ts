import { createHash } from "node:crypto";
import { PLUGIN_ID } from "./platforms.js";

export { PLUGIN_ID };
export const NAMESPACE_SLUG = "social";

export function pluginNamespace(pluginId = PLUGIN_ID, slug = NAMESPACE_SLUG): string {
  const hash = createHash("sha256").update(pluginId).digest("hex").slice(0, 10);
  const safeSlug = slug.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_").slice(0, 36) || "plugin";
  return `plugin_${safeSlug}_${hash}`.slice(0, 63);
}

export const NAMESPACE = pluginNamespace();
