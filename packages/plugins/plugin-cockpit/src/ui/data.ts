/**
 * Loads everything the Cockpit page and widget show for one company.
 * Live snapshots come from each installed, ready, switched-on plugin; the
 * stored projection fills in for any that cannot answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { pluginUiBaseFromModule } from "@partnersinbiz/pib-plugin-kit/oauth-client";
import { fetchModules } from "@partnersinbiz/pib-plugin-kit/setup-client";
import type { ModuleKey, SetupStatus } from "@partnersinbiz/pib-plugin-kit/setup";
import { pluginEnabled, setupMissingCount, type AgentLite, type ApprovalLite, type CockpitSnapshot, type HostActivityLite, type IssueLite, type RunLite } from "../merge.js";
import { buildView, type CockpitView, type InstalledLite, type LoadResult } from "../view.js";
import {
  fetchActivity,
  fetchAgents,
  fetchApprovals,
  fetchBackup,
  fetchInstalledPlugins,
  fetchLiveSnapshot,
  fetchMyIssues,
  fetchRuns,
  fetchSetupLoad,
  MODULE_PLUGIN_KEYS,
} from "./api.js";

export interface RawData {
  load: LoadResult;
  installed: Record<string, InstalledLite> | null;
  modules: Partial<Record<ModuleKey, boolean>> | null;
  live: Record<string, CockpitSnapshot | null>;
  approvals: ApprovalLite[];
  myIssues: IssueLite[];
  setupMissing: number | null;
  agents: AgentLite[];
  hostActivity: HostActivityLite[];
  runs: RunLite[];
  backup: { mtime: string | null; ageHours: number | null } | null;
}

export interface CockpitData {
  loading: boolean;
  error: string | null;
  raw: RawData | null;
  view: CockpitView | null;
  reload(): Promise<void>;
}

/** `/_plugins/<installation id>/ui/` of this bundle, or null outside the host. */
export function uiBase(): string | null {
  try {
    return pluginUiBaseFromModule(import.meta.url);
  } catch {
    return null;
  }
}

type LoadAction = (params: Record<string, unknown>) => Promise<unknown>;

/** Everything the Cockpit needs for one company. `light` skips live snapshots, agents, activity, runs and backups. */
export async function loadRawData(companyId: string, loadAction: LoadAction, light: boolean): Promise<RawData> {
  const installed = await fetchInstalledPlugins();
  const report = installed ? Object.fromEntries(Object.entries(installed).map(([key, p]) => [key, { id: p.id, status: p.status }])) : undefined;
  const [load, modules] = await Promise.all([
    loadAction({ ...(report ? { installed: report } : {}), uiBase: uiBase(), team: !light }) as Promise<LoadResult>,
    fetchModules(companyId),
  ]);
  const livePlugins = light
    ? []
    : MODULE_PLUGIN_KEYS.filter((key) => pluginEnabled(modules, key) && (!installed || installed[key]?.status === "ready"));
  const [liveList, approvals, myIssues, setupLoad, agents, hostActivity, runs, backup] = await Promise.all([
    Promise.all(livePlugins.map(async (key) => [key, await fetchLiveSnapshot(key, companyId)] as const)),
    fetchApprovals(companyId),
    fetchMyIssues(companyId),
    fetchSetupLoad(companyId),
    light ? Promise.resolve([] as AgentLite[]) : fetchAgents(companyId),
    light ? Promise.resolve([] as HostActivityLite[]) : fetchActivity(companyId),
    light ? Promise.resolve([] as RunLite[]) : fetchRuns(companyId),
    light ? Promise.resolve(null) : fetchBackup(),
  ]);
  const setupMissing = setupLoad
    ? setupMissingCount(
      Object.fromEntries(Object.entries(setupLoad.statuses ?? {}).map(([key, row]) => [key, (row?.status ?? null) as SetupStatus | null])),
      (setupLoad.modules ?? modules) as Partial<Record<ModuleKey, boolean>> | null,
    )
    : null;
  return {
    load,
    installed,
    modules,
    live: Object.fromEntries(liveList),
    approvals,
    myIssues,
    setupMissing,
    agents,
    hostActivity,
    runs,
    backup,
  };
}

export function useCockpitData(companyId: string | null | undefined, options: { light?: boolean; windowHours?: number } = {}): CockpitData {
  const loadAction = usePluginAction("cockpit.load");
  const [raw, setRaw] = useState<RawData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const token = useRef(0);
  const light = options.light === true;

  const reload = useCallback(async () => {
    if (!companyId) return;
    const mine = ++token.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadRawData(companyId, loadAction as LoadAction, light);
      if (mine !== token.current) return;
      setRaw(next);
    } catch (err) {
      if (mine !== token.current) return;
      setError(err instanceof Error ? err.message : "Could not load the Cockpit");
    } finally {
      if (mine === token.current) setLoading(false);
    }
  }, [companyId, loadAction, light]);

  useEffect(() => {
    setRaw(null);
    void reload();
  }, [companyId]);

  const windowMs = (options.windowHours ?? 24) * 3_600_000;
  const view = useMemo(() => (raw ? buildView({ ...raw, now: new Date(), windowMs }) : null), [raw, windowMs]);
  return { loading, error, raw, view, reload };
}

// ---------------------------------------------------------------------------
// Sidebar: one shared light load for the Cockpit row and the three groups
// ---------------------------------------------------------------------------

const SIDEBAR_TTL_MS = 30_000;
const SIDEBAR_REFRESH_MS = 60_000;
const sidebarCache = new Map<string, { at: number; promise: Promise<CockpitView | null> }>();

/** The light Cockpit view for the sidebar, shared by every sidebar row and loaded at most every 30 seconds. */
export function sharedSidebarView(companyId: string, loadAction: LoadAction, now: () => number = Date.now): Promise<CockpitView | null> {
  const hit = sidebarCache.get(companyId);
  if (hit && now() - hit.at < SIDEBAR_TTL_MS) return hit.promise;
  const promise = loadRawData(companyId, loadAction, true)
    .then((raw) => buildView({ ...raw, now: new Date(), windowMs: 24 * 3_600_000 }))
    .catch(() => null);
  sidebarCache.set(companyId, { at: now(), promise });
  return promise;
}

export function clearSidebarCache(): void {
  sidebarCache.clear();
}

/** Refreshes when you move between pages and once a minute (within the 30-second sharing window). */
export function useSidebarView(companyId: string | null | undefined, pathname: string): CockpitView | null {
  const loadAction = usePluginAction("cockpit.load") as LoadAction;
  const [view, setView] = useState<CockpitView | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), SIDEBAR_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!companyId) {
      setView(null);
      return;
    }
    let live = true;
    void sharedSidebarView(companyId, loadAction).then((next) => {
      if (live && next) setView(next);
    });
    return () => {
      live = false;
    };
  }, [companyId, pathname, tick]);
  return view;
}
