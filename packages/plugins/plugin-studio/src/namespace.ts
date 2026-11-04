import { createHash } from "node:crypto";

export const PLUGIN_ID = "partnersinbiz.studio";
export const NAMESPACE_SLUG = "studio";

export function pluginNamespace(pluginId = PLUGIN_ID, slug = NAMESPACE_SLUG): string {
  const hash = createHash("sha256").update(pluginId).digest("hex").slice(0, 10);
  return `plugin_${slug}_${hash}`.slice(0, 63);
}

export const NAMESPACE = pluginNamespace();
