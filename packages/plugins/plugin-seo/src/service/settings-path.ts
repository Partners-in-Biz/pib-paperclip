import { pluginUiBase } from "@partnersinbiz/pib-plugin-kit";
import type { CompanyInfo, Env } from "./common.js";

/** Plugin settings page (by installation id, from the UI base the SEO page reported). */
export async function settingsPath(env: Env, info: CompanyInfo): Promise<string | null> {
  const uiBase = await pluginUiBase(env.ctx).catch(() => null);
  const id = uiBase ? /\/_plugins\/([^/]+)\//.exec(uiBase)?.[1] : null;
  if (!info.prefix) return null;
  return id ? `/${info.prefix}/company/settings/instance/plugins/${id}` : `/${info.prefix}/company/settings/instance/plugins`;
}
