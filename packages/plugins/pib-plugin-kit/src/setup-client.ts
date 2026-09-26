/**
 * Browser helpers for module switches (import via
 * `@partnersinbiz/pib-plugin-kit/setup-client`). No node imports.
 *
 * Sidebar entries call `moduleEnabled(companyId, pluginKey)` and render
 * nothing when the company switched the module off. When the Setup plugin is
 * not installed or unreachable, everything counts as enabled.
 */
import { moduleOfPlugin, SETUP_PLUGIN, type ModuleKey } from "./setup.js";

const cache = new Map<string, { at: number; modules: Partial<Record<ModuleKey, boolean>> | null }>();

export async function fetchModules(companyId: string): Promise<Partial<Record<ModuleKey, boolean>> | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < 60_000) return hit.modules;
  let modules: Partial<Record<ModuleKey, boolean>> | null = null;
  try {
    const res = await fetch(`/api/plugins/${SETUP_PLUGIN}/api/modules?companyId=${encodeURIComponent(companyId)}`, { credentials: "include" });
    if (res.ok) {
      const body = (await res.json()) as { modules?: Partial<Record<ModuleKey, boolean>> | null; data?: { modules?: Partial<Record<ModuleKey, boolean>> | null } };
      modules = body.modules ?? body.data?.modules ?? null;
    }
  } catch {
    modules = null;
  }
  cache.set(companyId, { at: Date.now(), modules });
  return modules;
}

export async function moduleEnabled(companyId: string | null | undefined, pluginKey: string): Promise<boolean> {
  if (!companyId) return true;
  const module = moduleOfPlugin(pluginKey);
  if (!module) return true;
  const modules = await fetchModules(companyId);
  return modules?.[module] !== false;
}

export function clearModuleCache(): void {
  cache.clear();
}
