/**
 * Browser helpers for module switches (import via
 * `@partnersinbiz/pib-plugin-kit/setup-client`). No node imports.
 *
 * Sidebar entries call `moduleEnabled(companyId, pluginKey)` and render
 * nothing when the company switched the module off. When the Setup plugin is
 * not installed or unreachable, everything counts as enabled.
 */
import { moduleOfPlugin, SETUP_PLUGIN, type ModuleKey } from "./setup.js";

type Modules = Partial<Record<ModuleKey, boolean>> | null;
type Entry = { at: number; ttl: number; promise: Promise<Modules> };

/**
 * One cache for every PiB plugin on the page (each plugin bundles its own copy
 * of this file), holding the request itself, so a page with a dozen sidebar
 * rows and cards asks the Setup plugin once, not once per row.
 */
function sharedCache(): Map<string, Entry> {
  const scope = globalThis as { __pibModulesCache?: Map<string, Entry> };
  if (!scope.__pibModulesCache) scope.__pibModulesCache = new Map();
  return scope.__pibModulesCache;
}

export function fetchModules(companyId: string): Promise<Modules> {
  const cache = sharedCache();
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.promise;
  const entry: Entry = { at: Date.now(), ttl: 60_000, promise: Promise.resolve(null) };
  entry.promise = (async () => {
    try {
      const res = await fetch(`/api/plugins/${SETUP_PLUGIN}/api/modules?companyId=${encodeURIComponent(companyId)}`, { credentials: "include" });
      if (!res.ok) {
        entry.ttl = 10_000;
        return null;
      }
      const body = (await res.json()) as { modules?: Modules; data?: { modules?: Modules } };
      return body.modules ?? body.data?.modules ?? null;
    } catch {
      entry.ttl = 10_000;
      return null;
    }
  })();
  cache.set(companyId, entry);
  return entry.promise;
}

export async function moduleEnabled(companyId: string | null | undefined, pluginKey: string): Promise<boolean> {
  if (!companyId) return true;
  const module = moduleOfPlugin(pluginKey);
  if (!module) return true;
  const modules = await fetchModules(companyId);
  return modules?.[module] !== false;
}

export function clearModuleCache(): void {
  sharedCache().clear();
}
