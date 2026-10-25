/**
 * Browser helpers for module switches (import via
 * `@partnersinbiz/pib-plugin-kit/setup-client`). No node imports.
 *
 * Sidebar entries call `moduleEnabled(companyId, pluginKey)` and render
 * nothing when the company switched the module off or it is not in its plan;
 * a page calls `moduleState` to say which. When the Setup plugin is
 * not installed or unreachable, everything counts as enabled.
 */
import { moduleOfPlugin, SETUP_PLUGIN, type ModuleKey } from "./setup.js";

/** What a page does with a module: shows it, says "turn it on in Setup", or says "not in your plan". */
export type ModuleState = "on" | "off" | "not_entitled";

type Modules = Partial<Record<ModuleKey, boolean>> | null;
/** `enabled` is the company's own switch, `entitled` its plan. Either is null for a Setup that predates 0.6.1. */
export interface ModuleSwitches {
  modules: Modules;
  enabled: Modules;
  entitled: Modules;
}
type Entry = { at: number; ttl: number; promise: Promise<ModuleSwitches | null> };

/**
 * One cache for every PiB plugin on the page (each plugin bundles its own copy
 * of this file), holding the request itself, so a page with a dozen sidebar
 * rows and cards asks the Setup plugin once, not once per row. The key carries
 * the payload shape: copies from before 0.5.0 use `__pibModulesCache` and keep to themselves.
 */
function sharedCache(): Map<string, Entry> {
  const scope = globalThis as { __pibModuleSwitchesCache?: Map<string, Entry> };
  if (!scope.__pibModuleSwitchesCache) scope.__pibModuleSwitchesCache = new Map();
  return scope.__pibModuleSwitchesCache;
}

function fetchSwitches(companyId: string): Promise<ModuleSwitches | null> {
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
      const body = (await res.json()) as Partial<ModuleSwitches> & { data?: Partial<ModuleSwitches> };
      const source = body.modules !== undefined || body.enabled !== undefined || body.entitled !== undefined ? body : body.data ?? {};
      return { modules: source.modules ?? null, enabled: source.enabled ?? null, entitled: source.entitled ?? null };
    } catch {
      entry.ttl = 10_000;
      return null;
    }
  })();
  cache.set(companyId, entry);
  return entry.promise;
}

/** The effective switches (the company's choice AND its plan); null when Setup is unreachable. */
export async function fetchModules(companyId: string): Promise<Modules> {
  return (await fetchSwitches(companyId))?.modules ?? null;
}

/**
 * Pure: the state of one module. Not in the plan wins over off. A Setup without
 * `entitled`/`enabled` (older than 0.6.1) only has the combined `modules`, which reads as off.
 */
export function moduleStateOf(switches: ModuleSwitches | null, module: ModuleKey): ModuleState {
  if (!switches) return "on";
  if (switches.entitled?.[module] === false) return "not_entitled";
  if (switches.enabled?.[module] === false) return "off";
  if (switches.modules?.[module] === false) return "off";
  return "on";
}

/** `on` also when there is no company, no module for the plugin, or Setup cannot be reached. */
export async function moduleState(companyId: string | null | undefined, pluginKey: string): Promise<ModuleState> {
  if (!companyId) return "on";
  const module = moduleOfPlugin(pluginKey);
  if (!module) return "on";
  return moduleStateOf(await fetchSwitches(companyId), module);
}

/** True only when the company switched the module on and its plan includes it. */
export async function moduleEnabled(companyId: string | null | undefined, pluginKey: string): Promise<boolean> {
  return (await moduleState(companyId, pluginKey)) === "on";
}

export function clearModuleCache(): void {
  sharedCache().clear();
}
